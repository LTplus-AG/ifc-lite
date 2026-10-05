/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan outline tracer's worker protocol (#6884 review): latest-wins with
 * one job in flight, stale results dropped, sources sent once and then by
 * key, and `dispose()` settling everything. The worker is a stand-in that
 * runs the real job (`resolveSources` + `runScanOutlineJob`, the worker's own
 * body) on the real wasm engine, asynchronously like a thread would.
 */

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWasm, roomSlab } from '@/test/scan-slab-fixture';
import { resolveSources, type ScanOutlineWorkerRequest } from '@/workers/scanOutline.worker';
import { runScanOutlineJob, type ScanOutlineSource } from './scan-outline-job';
import { createScanOutlineTracer } from './scan-outline-tracer';

/** The room slab lifted into a 3D sample on a horizontal plane at y = 1. */
function sample(): ScanOutlineSource {
  const xy = roomSlab();
  const positions = new Float32Array((xy.length / 2) * 3);
  for (let i = 0; i < xy.length / 2; i++) {
    positions[i * 3] = xy[i * 2];
    positions[i * 3 + 1] = 1;
    positions[i * 3 + 2] = -xy[i * 2 + 1];
  }
  return { positions, count: xy.length / 2 };
}

const job = (source: ScanOutlineSource, maxGap = 0.3) => ({
  sources: [source],
  coordinateInfo: undefined,
  plane: { axis: 'y' as const, position: 1, flipped: false },
  thickness: 0.2,
  maxGap,
});

const posted: ScanOutlineWorkerRequest[] = [];

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  private cache = new Map<number, ScanOutlineSource>();
  postMessage(request: ScanOutlineWorkerRequest): void {
    posted.push(request);
    setTimeout(() => {
      if (this.terminated) return;
      const layer = runScanOutlineJob({ ...request.job, sources: resolveSources(request.sources, this.cache) });
      this.onmessage?.({ data: { type: 'complete', id: request.id, layer } } as MessageEvent);
    }, 5);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function withFakeWorker(t: TestContext): boolean {
  if (!ensureWasm(t)) return false;
  posted.length = 0;
  const previous = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  t.after(() => {
    (globalThis as { Worker?: unknown }).Worker = previous;
  });
  return true;
}

describe('scan outline tracer (#6871)', () => {
  it('runs the latest request and drops everything it superseded', async (t) => {
    if (!withFakeWorker(t)) return;
    const tracer = createScanOutlineTracer();
    const source = sample();
    const first = tracer.trace(job(source, 0.1));
    const second = tracer.trace(job(source, 0.2));
    const third = tracer.trace(job(source, 0.3));
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results.map((r) => r.status), ['superseded', 'superseded', 'done']);
    // Only the running job and the last one were ever traced.
    assert.deepEqual(posted.map((p) => p.job.maxGap), [0.1, 0.3]);
    const done = results[2];
    assert.ok(done.status === 'done');
    assert.equal(done.layer.rings.length, 2);
    tracer.dispose();
  });

  it('sends a source\'s points once, then only its key', async (t) => {
    if (!withFakeWorker(t)) return;
    const tracer = createScanOutlineTracer();
    const source = sample();
    await tracer.trace(job(source));
    await tracer.trace(job(source, 0.25));
    assert.ok(posted[0].sources[0].source, 'first request carries the points');
    assert.equal(posted[1].sources[0].source, undefined, 'second request names the cached key');
    assert.equal(posted[1].sources[0].key, posted[0].sources[0].key);
    tracer.dispose();
  });

  it('dispose settles the running and queued jobs as superseded', async (t) => {
    if (!withFakeWorker(t)) return;
    const tracer = createScanOutlineTracer();
    const source = sample();
    const running = tracer.trace(job(source));
    const queued = tracer.trace(job(source, 0.2));
    tracer.dispose();
    assert.deepEqual((await Promise.all([running, queued])).map((r) => r.status), ['superseded', 'superseded']);
  });

  it('the worker cache keeps only the sources the request names', () => {
    const store = new Map<number, ScanOutlineSource>([[1, sample()], [2, sample()]]);
    resolveSources([{ key: 2 }, { key: 3, source: sample() }], store);
    assert.deepEqual([...store.keys()].sort(), [2, 3]);
    assert.throws(() => resolveSources([{ key: 9 }], store), /never sent/);
  });
});
