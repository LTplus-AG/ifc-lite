/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  accountWorkerMessages,
  createLoadTracer,
  createPerfCounters,
  createWorkerTraceHost,
  enableWorkerTrace,
  estimateCloneBytes,
  meterTypedArrayArgs,
  type TraceSpansMessage,
} from './index.js';

describe('structural counters per load (#6957)', () => {
  it('attributes counter deltas to the load that was latest when they moved', () => {
    const counters = createPerfCounters();
    counters.add('gpu.buffers', 5); // before enable: dropped
    const tracer = createLoadTracer({ enabled: true, sink: null, counters, now: () => 0 });
    expect(counters.enabled).toBe(true);
    counters.add('gpu.buffers', 2); // before any load: belongs to none
    const a = tracer.startLoad('a', {}, 0);
    counters.add('gpu.buffers', 3);
    counters.add('copy.source.bytes', 100);
    a.finish();
    counters.add('gpu.buffers', 1); // deferred upload after finish still counts for `a`
    tracer.startLoad('b', {}, 10);
    counters.add('gpu.buffers', 7);
    const [snapA, snapB] = tracer.snapshots();
    expect(snapA.counters).toEqual({ 'gpu.buffers': 4, 'copy.source.bytes': 100 });
    expect(snapB.counters).toEqual({ 'gpu.buffers': 7 });
  });

  it('adds worker counters posted with spans, per thread and into the load total', async () => {
    const main = createPerfCounters();
    const worker = createPerfCounters();
    const tracer = createLoadTracer({ enabled: true, sink: null, counters: main, now: () => 0, timeOrigin: 0 });
    const trace = tracer.startLoad('l', {}, 0);
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({ spanNames: {}, post: (m) => posted.push(m), counters: worker, now: () => 0, timeOrigin: 0 });

    worker.add('wasm.bytesIn', 999); // before the enable message: not this load's
    const sent: unknown[] = [];
    enableWorkerTrace({ postMessage: (m: unknown) => sent.push(m) }, trace, 'geom-0');
    await host(sent[0], async () => {});
    // An UNTRACED message type still ships the counters it moved; one that moved none posts nothing.
    await host({ type: 'stream-chunk' }, async () => { worker.add('wasm.bytesIn', 40); });
    await host({ type: 'set-styles' }, async () => {});
    expect(posted).toHaveLength(1);
    for (const m of posted) trace.merge(m.payload);
    main.add('wasm.bytesIn', 2);
    const snap = tracer.latest()!;
    expect(snap.workerCounters).toEqual({ 'geom-0': { 'wasm.bytesIn': 40 } });
    expect(snap.counters).toEqual({ 'wasm.bytesIn': 42 });
  });

  it('flush() posts counters mid-handler, for a worker the host terminates before its handler returns', async () => {
    const worker = createPerfCounters();
    const posted: TraceSpansMessage[] = [];
    const host = createWorkerTraceHost({ spanNames: { 'prepass-streaming': 'prepass.scan' }, post: (m) => posted.push(m), counters: worker, now: () => 0, timeOrigin: 0 });
    host.flush(); // not enabled yet: nothing to post
    await host({ type: 'load-trace:enable', thread: 'prepass' }, async () => {});
    let postedBeforeReturn = -1;
    await host({ type: 'prepass-streaming' }, async () => {
      worker.add('wasm.bytesIn', 2_000);
      host.flush(); // before the final event the host terminates us on
      postedBeforeReturn = posted.length;
    });
    expect(postedBeforeReturn).toBe(1);
    expect(posted[0].payload).toMatchObject({ thread: 'prepass', spans: [], counters: { 'wasm.bytesIn': 2_000 } });
  });

  it('records nothing for a disabled tracer and leaves its registry off', () => {
    const counters = createPerfCounters();
    const tracer = createLoadTracer({ enabled: false, counters });
    tracer.startLoad('l');
    counters.add('x');
    expect(counters.enabled).toBe(false);
    expect(counters.read()).toEqual({});
  });
});

describe('worker message accounting (#6957)', () => {
  it('estimates clone bytes, counting a view\'s whole buffer once and transfers separately', () => {
    const buf = new ArrayBuffer(64);
    const moved = new ArrayBuffer(32);
    const est = estimateCloneBytes(
      { a: new Uint8Array(buf, 0, 8), b: new Float32Array(buf), c: new Uint8Array(moved), s: 'abcd', n: 1 },
      (b) => b === moved,
    );
    // keys a,b,c,s,n = 5 bytes; 'abcd' = 4; number = 8; buf once = 64.
    expect(est).toEqual({ cloneBytes: 5 + 4 + 8 + 64, transferBytes: 32, sharedBytes: 0 });
    const shared = estimateCloneBytes([new Uint8Array(new SharedArrayBuffer(16))]);
    expect(shared.sharedBytes).toBe(16);
  });

  it('counts both directions on the wrapped worker and skips trace control messages', () => {
    const counters = createPerfCounters();
    counters.enable();
    const sent: unknown[] = [];
    let onMessage: ((e: { data: unknown }) => void) | null = null;
    const worker = {
      postMessage: (m: unknown, _t?: unknown) => { sent.push(m); },
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => { onMessage = l; },
    };
    const wrapped = accountWorkerMessages(worker, 'geometry', counters);
    const jobs = new Uint32Array(4);
    wrapped.postMessage({ jobs }, [jobs.buffer]);
    wrapped.postMessage({ type: 'load-trace:enable', thread: 'geom-0' });
    onMessage!({ data: { positions: new Float32Array(10) } });
    onMessage!({ data: { type: 'load-trace:spans' } });
    expect(sent).toHaveLength(2); // the native post still runs for both
    expect(counters.read()).toEqual({
      'msg.geometry.out.count': 1,
      'msg.geometry.out.cloneBytes': 4, // the key "jobs"
      'msg.geometry.out.transferBytes': 16,
      'msg.geometry.out.sharedBytes': 0,
      'msg.geometry.in.count': 1,
      'msg.geometry.in.cloneBytes': 9, // the key "positions"
      'msg.geometry.in.bufferBytes': 40,
      'msg.geometry.in.sharedBytes': 0,
    });
  });

  it('returns the worker untouched when counters are off', () => {
    const post = () => {};
    const worker = { postMessage: post, addEventListener: () => { throw new Error('must not listen'); } };
    expect(accountWorkerMessages(worker, 'parser', createPerfCounters()).postMessage).toBe(post);
  });
});

describe('typed-array call meter (#6957)', () => {
  class Api {
    readonly ptr = 7;
    setSourceBytes(bytes: Uint8Array) { return this.ptr + bytes.length; }
    count() { return this.ptr; }
  }

  it('counts typed-array argument bytes per method and keeps the real receiver', () => {
    const counters = createPerfCounters();
    counters.enable();
    const api = meterTypedArrayArgs(new Api(), 'wasm', counters);
    expect(api.setSourceBytes(new Uint8Array(100))).toBe(107);
    expect(api.setSourceBytes.call(api, new Uint8Array(20))).toBe(27);
    expect(api.count()).toBe(7);
    expect(api).toBeInstanceOf(Api);
    expect(counters.read()).toEqual({ 'wasm.bytesIn': 120, 'wasm.setSourceBytes.calls': 2, 'wasm.setSourceBytes.bytes': 120 });
  });

  it('is the identity when counters are off', () => {
    const api = new Api();
    expect(meterTypedArrayArgs(api, 'wasm', createPerfCounters())).toBe(api);
  });
});
