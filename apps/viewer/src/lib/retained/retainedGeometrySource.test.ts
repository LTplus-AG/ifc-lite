/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M2-C: host messages → loader events and the retained summary, driven
 * through the real `RetainedClient` by a host protocol fixture.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamingGeometryEvent } from '@ifc-lite/geometry';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { ScriptedHostWorker, complete, published, refused, start } from '@/test/retained-host-fixture';
import { RetainedClient } from './retained-client';
import { RetainedHostError } from './retained-protocol';
import { retainedGeometryEvents, RetainedStallError, type RetainedPhase } from './retainedGeometrySource';

function run(worker: ScriptedHostWorker, options: Partial<Parameters<typeof retainedGeometryEvents>[2]> = {}) {
  const client = new RetainedClient(() => worker);
  const summaries: RetainedGeometrySummary[] = [];
  const phases: RetainedPhase[] = [];
  const events = retainedGeometryEvents(client, new Uint8Array([1]), {
    onSummary: (summary) => summaries.push(summary), onPhase: (phase) => phases.push(phase), ...options,
  });
  return { client, events, summaries, phases, last: () => summaries.at(-1)! };
}

/** Pull like the loader does: `next()` only, so stopping early does not abandon the stream. */
async function collect(events: AsyncIterator<StreamingGeometryEvent>, until?: (event: StreamingGeometryEvent) => boolean) {
  const out: StreamingGeometryEvent[] = [];
  while (true) {
    const result = await events.next();
    if (result.done) return out;
    out.push(result.value);
    if (until?.(result.value)) return out;
  }
}

const ids = (events: StreamingGeometryEvent[]) => events.flatMap((e) => e.type === 'batch' ? e.meshes.map((m) => m.expressId) : []);

describe('#7955 M2-C retained geometry source', () => {
  it('M11-I Cancel keeps every product already published in an atomic IFNS shard', async () => {
    const shard = new ArrayBuffer(32);
    const base = published(1);
    if (base.kind !== 'published') throw new Error('expected published fixture');
    const event = { ...base, meshes: [], instancedShards: [shard], meshCount: 3,
      instanceProducts: [1, 2, 3].map(expressId => ({ expressId, ifcType: base.ifcType, obligationsUnmet: base.obligationsUnmet })),
      bounds: { min: { x: 3, y: 5, z: 7 }, max: { x: 4, y: 6, z: 8 } } };
    const value = run(new ScriptedHostWorker([start([1, 2, 3, 4]), event]));
    const events = await collect(value.events, e => e.type === 'batch');
    value.client.cancel();
    await collect(value.events);
    const batch = events.find(e => e.type === 'batch');
    assert.equal(batch?.type, 'batch');
    if (batch?.type !== 'batch') throw new Error('missing batch');
    assert.deepEqual(batch.instancedShards, [shard]);
    assert.equal(batch.totalSoFar, 3);
    assert.deepEqual(batch.coordinateInfo?.originalBounds, event.bounds);
    assert.deepEqual(batch.meshes, []);
    assert.equal(value.last().published, 3);
    assert.deepEqual(value.last().refused.map(p => [p.expressId, p.code]), [[4, 'cancelled']]);
    value.client.unload();
  });
  it('completeness is complete exactly when every candidate published', async () => {
    const all = run(new ScriptedHostWorker([start([1, 2]), published(1), published(2), complete]));
    await collect(all.events);
    assert.equal(all.last().completeness, 'complete');
    assert.equal(all.last().refused.length, 0);
    all.client.unload();

    const one = run(new ScriptedHostWorker([start([1, 2]), published(1), refused(2, 'empty_result'), complete]));
    await collect(one.events);
    assert.equal(one.last().completeness, 'incomplete');
    assert.equal(one.summaries.slice(0, -1).every((s) => s.completeness === 'running'), true, 'running until the end');
    one.client.unload();
  });

  it('Cancel terminates the host; published products stay, unreached ones are listed cancelled', async () => {
    const worker = new ScriptedHostWorker([start([1, 2, 3, 4]), published(1), refused(2, 'opening_strategy')]);
    const { client, events, last } = run(worker);
    const seen = await collect(events, (e) => e.type === 'batch');
    await new Promise((resolve) => setTimeout(resolve, 10)); // the refusal arrives
    client.cancel(); // what the load's `interrupt` does
    const rest = await collect(events);
    assert.equal(worker.terminated, 1, 'Cancel terminates the host Worker');
    assert.deepEqual(ids([...seen, ...rest]), [1], 'the published product stays; nothing else is drawn');
    assert.equal(rest.at(-1)?.type, 'complete', 'the load completes with what was published');
    const summary = last();
    assert.deepEqual(summary.refused.map((r) => [r.expressId, r.code]), [[2, 'opening_strategy'], [3, 'cancelled'], [4, 'cancelled']]);
    assert.equal(summary.cancelled, 2);
    assert.equal(summary.completeness, 'incomplete');
    client.unload();
  });

  it('a superseding load that abandons the stream releases the host', async () => {
    const worker = new ScriptedHostWorker([start([1, 2]), published(1)]);
    const { client, events } = run(worker);
    await collect(events, (e) => e.type === 'batch');
    await events.return(undefined);
    assert.equal(worker.terminated, 1);
    client.unload();
  });

  it('publishes the session frame as the exact path does, with mesh bounds', async () => {
    const { client, events } = run(new ScriptedHostWorker([start([1], [2_600_000, 1_200_000, 400], true), published(1, 3), complete]));
    const out = await collect(events);
    const done = out.at(-1);
    assert.ok(done?.type === 'complete');
    assert.deepEqual(done.coordinateInfo.wasmRtcOffset, { x: 2_600_000, y: 1_200_000, z: 400 });
    assert.deepEqual(done.coordinateInfo.wasmRtcFrame, { x: 2_600_000, y: 1_200_000, z: 400, needsShift: true });
    assert.deepEqual(done.coordinateInfo.originalBounds, { min: { x: 3, y: 0, z: 0 }, max: { x: 4, y: 1, z: 0 } });
    const startEvent = out.find((e) => e.type === 'start');
    assert.ok(startEvent?.type === 'start' && startEvent.totalEstimate === 1);
    client.unload();

    const local = run(new ScriptedHostWorker([start([1], [0, 0, 0], false), published(1), complete]));
    const localDone = (await collect(local.events)).at(-1);
    assert.ok(localDone?.type === 'complete');
    assert.equal(localDone.coordinateInfo.wasmRtcOffset, undefined, 'no shift applied → no applied offset');
    local.client.unload();
  });

  it('reports the retained progress phases', async () => {
    const { client, events, phases } = run(new ScriptedHostWorker([start([1, 2]), refused(1, 'incomplete'), published(2), complete]));
    await collect(events);
    assert.deepEqual(phases[0], { phase: 'starting' });
    assert.deepEqual(phases.at(-1), { phase: 'products', done: 2, candidates: 2, refused: 1 });
    client.unload();
  });

  it('owns its stall budget: heartbeats while waiting, then a typed stall that ends the host', async () => {
    const worker = new ScriptedHostWorker([start([1, 2]), published(1)]);
    const { client, events, last } = run(worker, { productBudgetMs: 60, heartbeatMs: 10 });
    const out: StreamingGeometryEvent[] = [];
    await assert.rejects(async () => {
      for (let result = await events.next(); !result.done; result = await events.next()) out.push(result.value);
    }, RetainedStallError);
    assert.ok(out.some((e) => e.type === 'progress'), 'heartbeats keep the loader watchdog fed while a product runs');
    assert.equal(worker.terminated, 1, 'a stalled host is terminated');
    assert.equal(last().failure, 'Retained engine produced no product for 1 s');
    assert.deepEqual(last().refused.map((r) => [r.expressId, r.code]), [[2, 'cancelled']]);
    assert.equal(last().completeness, 'incomplete');
    client.unload();
  });

  it('a host failure is a model-level error, never a silent partial success', async () => {
    const worker = new ScriptedHostWorker([start([1, 2]), published(1), { kind: 'error', code: 'worker_crash', message: 'boom' }]);
    const { client, events, last } = run(worker);
    await assert.rejects(collect(events), (error: unknown) => error instanceof RetainedHostError && error.code === 'worker_crash');
    assert.match(last().failure ?? '', /boom/);
    assert.deepEqual(last().refused.map((r) => r.expressId), [2]);
    client.unload();
  });
});
