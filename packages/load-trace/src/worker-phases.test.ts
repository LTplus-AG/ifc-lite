/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createLoadTracer,
  createWorkerPhaseTrace,
  enableWorkerTrace,
  isTraceSpansMessage,
  type TraceSpansMessage,
} from './index.js';

describe('worker phase spans (#6979)', () => {
  it('records sequential steps and nested spans, flushes on demand, and aligns them on merge', () => {
    let mainNow = 0;
    const tracer = createLoadTracer({ enabled: true, now: () => mainNow, timeOrigin: 1_000_000, sink: null });
    const trace = tracer.startLoad('l', {}, 0);
    const parser = trace.begin('parser.worker');

    let workerNow = 0;
    const posted: TraceSpansMessage[] = [];
    const phases = createWorkerPhaseTrace({ post: (m) => posted.push(m), now: () => workerNow, timeOrigin: 1_000_100 });

    const sent: unknown[] = [];
    enableWorkerTrace({ postMessage: (m: unknown) => sent.push(m) }, trace, 'parser');
    expect(phases.accept({ type: 'parse' })).toBe(false);
    expect(phases.accept(sent[0])).toBe(true);
    expect(phases.enabled).toBe(true);

    const parse = phases.begin('parser.parse');
    phases.step('columnar.scanning');
    workerNow = 10;
    phases.step('columnar.scanning'); // a repeated progress phase keeps the open span
    workerNow = 20;
    phases.step('columnar.building-entities');
    workerNow = 30;
    expect(phases.span('parser.spatialReady.serialize', () => { workerNow = 35; return 7; })).toBe(7);
    phases.flush(); // the partial store is posted mid-parse
    expect(posted).toHaveLength(1);
    workerNow = 50;
    phases.step(null);
    phases.span('parser.transport.serialize', () => { workerNow = 60; });
    phases.end(parse);
    phases.flush();
    phases.flush(); // nothing new: no empty message
    expect(posted).toHaveLength(2);
    expect(posted.every(isTraceSpansMessage)).toBe(true);

    for (const m of posted) trace.merge(m.payload, parser);
    const spans = tracer.latest()!.spans.filter((s) => s.thread === 'parser').map((s) => [s.name, s.start, s.end, s.parentId]);
    expect(spans).toEqual([
      ['columnar.scanning', 100, 120, parser],
      ['parser.spatialReady.serialize', 130, 135, parser],
      ['columnar.building-entities', 120, 150, parser],
      ['parser.transport.serialize', 150, 160, parser],
      ['parser.parse', 100, 160, parser],
    ]);
  });

  it('ends a throwing span with an error flag and rethrows', () => {
    const posted: TraceSpansMessage[] = [];
    const phases = createWorkerPhaseTrace({ post: (m) => posted.push(m), now: () => 1, timeOrigin: 0 });
    phases.accept({ type: 'load-trace:enable', thread: 'parser' });
    expect(() => phases.span('parser.transport.serialize', () => { throw new Error('clone'); })).toThrow('clone');
    phases.flush();
    expect(posted[0].payload.spans).toEqual([expect.objectContaining({ name: 'parser.transport.serialize', attrs: { error: true } })]);
  });

  it('records and posts nothing until enabled', () => {
    const posted: TraceSpansMessage[] = [];
    const phases = createWorkerPhaseTrace({ post: (m) => posted.push(m) });
    expect(phases.enabled).toBe(false);
    expect(phases.begin('parser.parse')).toBe(-1);
    phases.step('columnar.scanning');
    expect(phases.span('x', () => 3)).toBe(3);
    phases.flush();
    expect(posted).toEqual([]);
  });
});

describe('worker phase spans over promises (#6979)', () => {
  it('ends the span when the promise settles', async () => {
    let now = 0;
    const posted: TraceSpansMessage[] = [];
    const phases = createWorkerPhaseTrace({ post: (m) => posted.push(m), now: () => now, timeOrigin: 0 });
    phases.accept({ type: 'load-trace:enable', thread: 'parser' });
    let release!: (v: number) => void;
    const pending = phases.span('parser.wasmInit', () => new Promise<number>((r) => { release = r; }));
    now = 40;
    release(1);
    expect(await pending).toBe(1);
    await expect(phases.span('parser.wasmInit2', () => Promise.reject(new Error('fetch')))).rejects.toThrow('fetch');
    await Promise.resolve();
    phases.flush();
    expect(posted[0].payload.spans).toEqual([
      expect.objectContaining({ name: 'parser.wasmInit', start: 0, end: 40 }),
      expect.objectContaining({ name: 'parser.wasmInit2', attrs: { error: true } }),
    ]);
  });
});
