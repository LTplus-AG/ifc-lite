/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { GeometryProcessor, type StreamingGeometryEvent } from '@ifc-lite/geometry';
import { bounds, fixtures, failure, type Family, type Receipt } from './contracts.js';
import { Retention } from './retention.js';
import { identity } from './identity.js';

async function bounded<T>(operation: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error('endpoint deadline')); }, Math.max(1, ms));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function consume(bytes: Uint8Array, family: Family, receipt: Receipt,
  controller: AbortController): Promise<Receipt> {
  const processor = new GeometryProcessor();
  const retention = new Retention();
  const events: StreamingGeometryEvent[] = [];
  let iterator: AsyncGenerator<StreamingGeometryEvent> | undefined;
  let failed = false;
  const start = performance.now();
  const deadline = start + fixtures[family].timeoutMs;
  try {
    await bounded(processor.init(), deadline - performance.now(), () => controller.abort());
    // Only cancellation is supplied. All geometry, worker, shard, prebuilt-index,
    // RTC and recovery options stay at their public SDK defaults.
    iterator = processor.processParallel(bytes, undefined, undefined, undefined, undefined,
      undefined, undefined, controller.signal);
    while (true) {
      const result = await bounded(iterator.next(), deadline - performance.now(), () => controller.abort());
      if (result.done) { receipt.generatorDone = true; break; }
      const event = result.value;
      if (receipt.complete) throw new Error('event after complete');
      if (++receipt.events > bounds.events) throw new Error('event bound');
      receipt.eventCounts[event.type] = (receipt.eventCounts[event.type] ?? 0) + 1;
      const collectStart = performance.now();
      retention.add(event);
      events.push(event);
      receipt.collectMs += performance.now() - collectStart;
      receipt.retainedBytes = retention.bytes;
      receipt.bufferCount = retention.bufferCount;
      if (event.type === 'workerMemory') receipt.workerMemory.push(event);
      if (event.type === 'complete') {
        receipt.complete = event;
        if (event.skippedHungElements !== undefined) throw new Error('skipped/recovered elements');
      }
    }
    if (controller.signal.aborted || !receipt.complete) throw new Error('aborted/incomplete stream');
    const workerIds = receipt.workerMemory.map(event => event.workerIndex);
    if (workerIds.length < 2 || new Set(workerIds).size !== workerIds.length) {
      throw new Error('missing/duplicate geometry worker-memory census');
    }
  } catch (error) {
    failed = true;
    receipt.status = 'refused';
    receipt.error = failure(error);
    controller.abort();
  } finally {
    if (iterator && !receipt.generatorDone) {
      try {
        await bounded(iterator.return(undefined), bounds.cleanupMs, () => controller.abort());
        receipt.generatorDone = true;
      } catch (error) { failed = true; receipt.cleanupError = failure(error); receipt.status = 'refused'; }
    }
    try { processor.dispose(); receipt.processorDisposed = true; }
    catch (error) { failed = true; receipt.cleanupError = failure(error); receipt.status = 'refused'; }
    receipt.elapsedMs = performance.now() - start;
  }
  try {
    if (!failed && receipt.complete) {
      receipt.status = 'geometry-drained';
      const hashStart = performance.now();
      receipt.identity = await bounded(identity(events, receipt.complete), bounds.hashMs, () => controller.abort());
      receipt.hashMs = performance.now() - hashStart;
      receipt.status = 'supported-output';
    }
  } catch (error) { receipt.status = 'refused'; receipt.error = failure(error); }
  finally { events.length = 0; retention.release(); }
  return receipt;
}
