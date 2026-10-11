/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createLoadTracer,
  createPerfCounters,
  createWorkerTraceHost,
  enableWorkerTrace,
  isTraceSpansMessage,
  type TraceSpansMessage,
} from './index.js';

describe('worker trace alignment (#6956)', () => {
  it('publishes the completed scan before a terminal event can terminate the worker (#6993)', async () => {
    let now = 10;
    const events: Array<TraceSpansMessage | { type: 'complete' }> = [];
    const counters = createPerfCounters();
    const host = createWorkerTraceHost({
      spanNames: { scan: 'prepass.scan' },
      post: (message) => events.push(message),
      counters,
      now: () => now,
      timeOrigin: 100,
    });
    await host({ type: 'load-trace:enable', thread: 'prepass' }, async () => {});
    await host({ type: 'scan' }, async () => {
      now = 25;
      counters.add('wasm.bytesIn', 40);
      host.flush('prepass.scan');
      events.push({ type: 'complete' });
      // The host can terminate us here; later handler cleanup is not observed.
      expect(events).toEqual([
        {
          type: 'load-trace:spans',
          payload: {
            thread: 'prepass', timeOrigin: 100,
            spans: [{ name: 'prepass.scan', start: 10, end: 25 }],
            counters: { 'wasm.bytesIn': 40 },
          },
        },
        { type: 'complete' },
      ]);
      now = 30;
    });
    expect(events).toHaveLength(2); // handler finally must not publish it twice
  });

  it('a terminal flush completes only its named work, preserving other in-flight spans (#6993)', async () => {
    let now = 0;
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({
      spanNames: { scan: 'prepass.scan', styles: 'styles.finalize' },
      post: (message) => posted.push(message),
      counters: createPerfCounters(), now: () => now, timeOrigin: 0,
    });
    await host({ type: 'load-trace:enable', thread: 'prepass' }, async () => {});
    let finishStyles!: () => void;
    const styles = host({ type: 'styles' }, () => new Promise<void>((resolve) => { finishStyles = resolve; }));
    now = 5;
    await host({ type: 'scan' }, async () => {
      now = 10;
      host.flush('prepass.scan');
    });
    expect(posted.flatMap((message) => message.payload.spans)).toEqual([
      { name: 'prepass.scan', start: 5, end: 10 },
    ]);
    now = 20;
    finishStyles();
    await styles;
    expect(posted[1].payload.spans).toEqual([{ name: 'styles.finalize', start: 0, end: 20 }]);
  });

  it('shifts worker spans onto the main clock by the timeOrigin difference', async () => {
    // Main thread started at epoch 1_000_000; the worker was created 250 ms later,
    // so worker-local t=10 is main-local t=260.
    let mainNow = 0;
    const tracer = createLoadTracer({ enabled: true, now: () => mainNow, timeOrigin: 1_000_000, sink: null });
    const trace = tracer.startLoad('l', {}, 0);
    const pool = trace.begin('geometry.pool');

    let workerNow = 10;
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({
      spanNames: { 'scan-shard': 'shard.scan', 'stream-chunk': 'geometry.firstChunk' },
      onceTypes: ['stream-chunk'],
      post: (m) => posted.push(m),
      now: () => workerNow,
      timeOrigin: 1_000_250,
    });

    // The enable request travels through the same channel as every other request.
    const sent: unknown[] = [];
    enableWorkerTrace({ postMessage: (m: unknown) => sent.push(m) }, trace, 'geom-0');
    expect(sent).toHaveLength(1);
    let ran = 0;
    await host(sent[0], async () => { ran++; });
    expect(ran).toBe(0); // the enable message is consumed by the host

    await host({ type: 'scan-shard' }, async () => { ran++; workerNow = 40; });
    await host({ type: 'stream-chunk' }, async () => { ran++; workerNow = 55; });
    await host({ type: 'stream-chunk' }, async () => { ran++; workerNow = 90; });
    await host({ type: 'set-styles' }, async () => { ran++; });
    expect(ran).toBe(4);
    expect(posted).toHaveLength(2);
    expect(posted.every(isTraceSpansMessage)).toBe(true);

    for (const m of posted) trace.merge(m.payload, pool);
    const spans = tracer.latest()!.spans.filter((s) => s.thread === 'geom-0');
    expect(spans).toEqual([
      expect.objectContaining({ name: 'shard.scan', start: 260, end: 290, parentId: pool }),
      expect.objectContaining({ name: 'geometry.firstChunk', start: 290, end: 305, parentId: pool }),
    ]);
  });

  it('posts the span even when the handler throws, and rethrows', async () => {
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({ spanNames: { init: 'worker.init' }, post: (m) => posted.push(m), now: () => 1, timeOrigin: 0 });
    await host({ type: 'load-trace:enable', thread: 'prepass' }, async () => {});
    await expect(host({ type: 'init' }, async () => { throw new Error('wasm'); })).rejects.toThrow('wasm');
    expect(posted[0].payload).toMatchObject({ thread: 'prepass', spans: [{ name: 'worker.init' }] });
  });

  it('is a pass-through until enabled, and enableWorkerTrace sends nothing when tracing is off', async () => {
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({ spanNames: { 'scan-shard': 'shard.scan' }, post: (m) => posted.push(m) });
    let ran = 0;
    await host({ type: 'scan-shard' }, async () => { ran++; });
    expect(ran).toBe(1);
    expect(posted).toEqual([]);

    const sent: unknown[] = [];
    const off = createLoadTracer({ enabled: false }).startLoad('l');
    const worker = { postMessage: (m: unknown) => sent.push(m) };
    expect(enableWorkerTrace(worker, off, 'geom-0')).toBe(worker);
    expect(sent).toEqual([]);
  });
});

// #7036: a persistent geometry worker must not attribute a later untraced load to an old epoch.
it('reset ends a worker trace epoch and restores untraced execution', async () => {
  const counters = createPerfCounters();
  const posted: TraceSpansMessage[] = [];
  const host = createWorkerTraceHost({ spanNames: { job: 'geometry.job' }, counters, post: m => posted.push(m) });
  await host({ type: 'load-trace:enable', thread: 'first' }, async () => {});
  await host({ type: 'job' }, async () => { counters.add('source.bytes', 20); });
  expect(posted).toHaveLength(1);
  host.reset();
  await host({ type: 'job' }, async () => { counters.add('source.bytes', 30); });
  expect(posted).toHaveLength(1);
  expect(counters.read()).toEqual({});
  await host({ type: 'load-trace:enable', thread: 'second' }, async () => {});
  await host({ type: 'job' }, async () => { counters.add('source.bytes', 7); });
  expect(posted[1].payload.thread).toBe('second');
  expect(posted[1].payload.counters).toEqual({ 'source.bytes': 7 });
});

it('#7036 an old handler finishing after reset cannot flush into a new trace epoch', async () => {
  const counters = createPerfCounters();
  const posted: TraceSpansMessage[] = [];
  const host = createWorkerTraceHost({ spanNames: { job: 'geometry.job' }, counters, post: m => posted.push(m) });
  await host({ type: 'load-trace:enable', thread: 'old' }, async () => {});
  let finishOld: (() => void) | undefined;
  const old = host({ type: 'job' }, () => new Promise(resolve => { finishOld = resolve; }));
  host.reset();
  await host({ type: 'load-trace:enable', thread: 'new' }, async () => {});
  await host({ type: 'job' }, async () => { counters.add('new.bytes', 7); });
  finishOld?.();
  await old;
  expect(posted).toHaveLength(1);
  expect(posted[0].payload.thread).toBe('new');
  expect(posted[0].payload.counters).toEqual({ 'new.bytes': 7 });
  expect(posted[0].payload.spans).toHaveLength(1);
});
