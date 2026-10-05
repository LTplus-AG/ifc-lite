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
import { resolveSources, type ScanOutlinePoints, type ScanOutlineWorkerRequest } from '@/workers/scanOutline.worker';
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
  private cache = new Map<number, ScanOutlinePoints>();
  postMessage(message: ScanOutlineWorkerRequest): void {
    posted.push(message);
    // A real postMessage structured-clones: the worker never sees later
    // main-thread mutations of what was sent.
    const request = structuredClone(message);
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
    assert.ok(posted[0].sources[0].points, 'first request carries the points');
    assert.equal(posted[1].sources[0].points, undefined, 'second request names the cached key');
    assert.equal(posted[1].sources[0].key, posted[0].sources[0].key);
    tracer.dispose();
  });

  it('a source sent again with a new transform traces through the new transform (#6884 review)', async (t) => {
    if (!withFakeWorker(t)) return;
    const tracer = createScanOutlineTracer();
    const source = sample();
    const before = await tracer.trace(job(source));
    // The same retained points, now drawn 10 m further along x (alignment
    // toggled, model moved): only the matrix is new.
    const moved = { ...source, model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]), modelOutputsRenderFrame: true };
    const after = await tracer.trace(job(moved));
    const expected = runScanOutlineJob(job(moved));
    assert.ok(before.status === 'done' && after.status === 'done');
    assert.deepEqual(after.layer.rings, expected.rings, 'the worker used the new matrix');
    assert.notDeepEqual(after.layer.rings, before.layer.rings);
    tracer.dispose();
  });

  it('a retained buffer rewritten in place is sent again when its revision moves (#6884 review)', async (t) => {
    if (!withFakeWorker(t)) return;
    const tracer = createScanOutlineTracer();
    const source = { ...sample(), revision: 1 };
    await tracer.trace(job(source));
    // The scan cache's reservoir overwrites slots in place: same array, same count.
    for (let i = 0; i < source.count; i++) source.positions[i * 3] += 10;
    const rewritten = { ...source, revision: 2 };
    const after = await tracer.trace(job(rewritten));
    assert.ok(after.status === 'done');
    assert.deepEqual(after.layer.rings, runScanOutlineJob(job(rewritten)).rings, 'the worker traced the rewritten points');
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
    const store = new Map<number, ScanOutlinePoints>([[1, sample()], [2, sample()]]);
    const resolved = resolveSources([{ key: 2, count: 5 }, { key: 3, count: 7, points: sample() }], store);
    assert.deepEqual([...store.keys()].sort(), [2, 3]);
    assert.deepEqual(resolved.map((s) => s.count), [5, 7], 'the count comes with every request');
    assert.throws(() => resolveSources([{ key: 9, count: 1 }], store), /never sent/);
  });
});
