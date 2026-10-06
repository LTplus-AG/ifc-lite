/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { buildSpanTree, createLoadTracer, toChromeTrace, type PerfSink } from './index.js';
import { createPerfSink } from './perf-sink.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; } };
}

function recordingSink() {
  const measures: Array<{ name: string; start: number; end: number }> = [];
  const sink: PerfSink = { measure: (name, start, end) => { measures.push({ name, start, end }); } };
  return { sink, measures };
}

describe('load trace (#6956)', () => {
  it('builds a per-load span tree with parents, milestones and attributes', () => {
    const c = clock(100);
    const { sink, measures } = recordingSink();
    const tracer = createLoadTracer({ enabled: true, now: c.now, timeOrigin: 0, sink });
    const trace = tracer.startLoad('model-a', { journey: 'J1', modelKind: 'primary' }, 100);

    c.set(110);
    const pool = trace.begin('geometry.pool');
    c.set(115);
    trace.span('shard.stitch', () => { c.set(118); }, undefined, pool);
    c.set(130);
    expect(trace.milestone('geometry.firstBatch')).toBe(30);
    c.set(140);
    // Only the first call per name is recorded; later calls still report elapsed.
    expect(trace.milestone('geometry.firstBatch')).toBe(40);
    trace.end(pool);
    trace.record('file.read', 101, 105);
    trace.setAttrs({ workerCount: 4 });
    c.set(200);
    expect(trace.finish({ loadPath: 'wasm' })).toBe(100);

    const snap = tracer.latest();
    expect(snap).not.toBeNull();
    expect(snap!.attrs).toEqual({ journey: 'J1', modelKind: 'primary', workerCount: 4, loadPath: 'wasm' });
    expect(snap!.end).toBe(200);
    const byName = Object.fromEntries(snap!.spans.map((s) => [s.name, s]));
    expect(byName['geometry.firstBatch']).toMatchObject({ start: 100, end: 130, milestone: true, parentId: null });
    expect(snap!.spans.filter((s) => s.name === 'geometry.firstBatch')).toHaveLength(1);

    const tree = buildSpanTree(snap!);
    expect(tree.map((n) => n.span.name)).toEqual(['geometry.firstBatch', 'file.read', 'geometry.pool']);
    const poolNode = tree.find((n) => n.span.name === 'geometry.pool')!;
    expect(poolNode.span).toMatchObject({ start: 110, end: 140 });
    expect(poolNode.children.map((n) => n.span)).toEqual([
      expect.objectContaining({ name: 'shard.stitch', start: 115, end: 118 }),
    ]);

    // Every finished span is mirrored into User Timing under the ifc: prefix.
    expect(measures.map((m) => m.name)).toEqual([
      'ifc:shard.stitch', 'ifc:geometry.firstBatch', 'ifc:geometry.pool', 'ifc:file.read', 'ifc:load',
    ]);
  });

  it('ends an async span when its promise settles and returns the original promise', async () => {
    const c = clock();
    const tracer = createLoadTracer({ enabled: true, now: c.now, timeOrigin: 0, sink: null });
    const trace = tracer.startLoad('l', {}, 0);
    let resolve!: (v: number) => void;
    const p = new Promise<number>((r) => { resolve = r; });
    const returned = trace.span('cache.lookup', () => p);
    expect(returned).toBe(p);
    c.set(25);
    resolve(7);
    expect(await returned).toBe(7);
    await Promise.resolve();
    expect(tracer.latest()!.spans[0]).toMatchObject({ name: 'cache.lookup', start: 0, end: 25 });

    const failing = trace.span('engine.init', () => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');
    await Promise.resolve();
    expect(tracer.latest()!.spans[1]).toMatchObject({ name: 'engine.init', attrs: { error: true } });
    expect(() => trace.span('x', () => { throw new Error('sync'); })).toThrow('sync');
    expect(tracer.latest()!.spans[2]).toMatchObject({ name: 'x', end: 25, attrs: { error: true } });
  });

  it('disabled mode records nothing but keeps the same return values', () => {
    const c = clock(50);
    const { sink, measures } = recordingSink();
    const tracer = createLoadTracer({ enabled: false, now: c.now, timeOrigin: 0, sink });
    const trace = tracer.startLoad('l', { journey: 'J1' }, 50);
    expect(trace.enabled).toBe(false);
    expect(trace.begin('a')).toBe(-1);
    expect(trace.span('b', () => 42)).toBe(42);
    c.set(80);
    expect(trace.milestone('parser.start')).toBe(30);
    expect(trace.milestone('geometry.firstVisible', 12)).toBe(12);
    trace.merge({ thread: 'geom-0', timeOrigin: 0, spans: [{ name: 'w', start: 0, end: 1 }] });
    expect(trace.finish()).toBe(30);
    expect(trace.snapshot()).toBeNull();
    expect(tracer.snapshots()).toEqual([]);
    expect(measures).toEqual([]);
  });

  it('retains only the most recent loads', () => {
    const tracer = createLoadTracer({ enabled: true, timeOrigin: 0, sink: null, maxLoads: 2 });
    for (const id of ['a', 'b', 'c']) tracer.startLoad(id);
    expect(tracer.snapshots().map((s) => s.loadId)).toEqual(['b', 'c']);
  });

  it('exports finished spans as Chrome-trace complete events, one track per thread', () => {
    const c = clock();
    const tracer = createLoadTracer({ enabled: true, now: c.now, timeOrigin: 1000, sink: null });
    const trace = tracer.startLoad('l', { journey: 'J2' }, 0);
    trace.record('cache.decode', 1, 3.5);
    trace.merge({ thread: 'geom-0', timeOrigin: 1000, spans: [{ name: 'shard.scan', start: 2, end: 4 }] });
    trace.begin('still.open');
    c.set(10);
    trace.finish();
    const { traceEvents } = toChromeTrace(tracer.snapshots());
    const complete = traceEvents.filter((e) => e.ph === 'X');
    expect(complete).toEqual([
      expect.objectContaining({ name: 'load', tid: 0, ts: 0, dur: 10000, args: { loadId: 'l', journey: 'J2' } }),
      expect.objectContaining({ name: 'cache.decode', tid: 0, ts: 1000, dur: 2500 }),
      expect.objectContaining({ name: 'shard.scan', tid: 1, ts: 2000, dur: 2000 }),
    ]);
    expect(traceEvents.filter((e) => e.name === 'thread_name').map((e) => e.args?.name)).toEqual(['main', 'geom-0']);
  });
});

describe('perf sink', () => {
  it('falls back to Performance.prototype.measure when the instance method is nulled (viewer DEV bootstrap)', () => {
    const calls: unknown[] = [];
    class FakePerformance { measure(name: string, opts: unknown) { calls.push([name, opts]); } }
    const g = globalThis as unknown as { Performance?: unknown };
    const saved = g.Performance;
    g.Performance = FakePerformance;
    try {
      const perf = new FakePerformance() as unknown as { measure?: unknown };
      perf.measure = undefined;
      const sink = createPerfSink(perf as unknown as Performance);
      expect(sink).not.toBeNull();
      sink!.measure('ifc:x', -5, -10, { loadId: 'l' });
      expect(calls).toEqual([['ifc:x', { start: 0, end: 0, detail: { loadId: 'l' } }]]);
    } finally {
      g.Performance = saved;
    }
  });
});
