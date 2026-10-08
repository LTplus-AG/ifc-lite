/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import { contiguousSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcTypeEnum, type SpatialHierarchy } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { __setOverlayWorkerFactoryForTest, JOB_TIMEOUT_MS, parseSymbolicFlat } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import { registerRoomSymbolicSource, type RoomSymbolicSource } from '../lib/collab/room-symbolic-source.js';
import { __resetSymbolicAnnotationsCacheForTests, ensureParseFor, getParseFor, subscribeToParseCache } from './symbolic-parse-cache.js';
import type { SymbolicParseOutcome } from './symbolic-parse-outcomes.js';

// #6537: lifecycle/observer invariants through the REAL cache/dispatch/bucketer.
// This seam supplies worker replies; it does not claim to validate the WASM parser.
class HeldWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: { id: number }[] = [];
  terminated = 0;
  failPost = false;
  postMessage(request: { id: number }, transfer?: unknown[]): void {
    assert.equal(transfer, undefined, 'canonical handoff must not detach the source');
    if (this.failPost) throw new Error('controlled structured-clone failure');
    this.posted.push(request);
  }
  terminate(): void { this.terminated++; }
  reply(flat = createEmptyFlatSymbolic()): void {
    assert.ok(this.posted[0], 'the real dispatch must have posted its request');
    this.onmessage?.({ data: { id: this.posted[0].id, ok: true, flat } });
  }
}
let workers: HeldWorker[];
let previousFactory: ReturnType<typeof __setOverlayWorkerFactoryForTest>;
beforeEach(() => {
  __resetSymbolicAnnotationsCacheForTests();
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, geometryResult: null, loading: false, mutationVersion: 0, mutationViews: new Map() });
  workers = [];
  previousFactory = __setOverlayWorkerFactoryForTest(() => {
    const worker = new HeldWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  // #6537: an empty session must refuse certification, including when the
  // production observer is absent. Fail an invariant rather than throwing on
  // a missing API before the revert oracle can observe an assertion.
  assert.equal(useViewerStore.getState().readSymbolicParseOutcomes?.().reason, 'no-model');
});
afterEach(() => {
  __setOverlayWorkerFactoryForTest(previousFactory);
  mock.timers.reset();
});
function store(id: string, owner = true): IfcDataStore {
  const value = fixtureDataStore([{ expressId: 2, type: owner ? 'IfcAnnotation' : 'IfcWall' }]);
  value.source = contiguousSourceBytes(new TextEncoder().encode(`lifecycle-fixture-${id}`));
  return value;
}
function select(value: IfcDataStore): void { useViewerStore.setState({ ifcDataStore: value }); }
function census() { return useViewerStore.getState().readSymbolicParseOutcomes(); }
function outcome(): SymbolicParseOutcome {
  const observed = census().models[0]?.outcome;
  assert.ok(observed, 'actual store consumer must identify the current model');
  return observed;
}
function terminal() {
  const observed = outcome();
  assert.equal(observed.phase, 'terminal');
  assert.ok(observed.phase === 'terminal');
  return observed;
}
async function posted(): Promise<HeldWorker> {
  // Microtask scheduling only; no timed sleeps and no bypass of dispatch.
  for (let i = 0; i < 20 && !workers[0]?.posted.length; i++) await Promise.resolve();
  const worker = workers[0];
  assert.ok(worker?.posted.length, 'canonical parse never reached its actual worker dispatch');
  return worker;
}
function lines(count = 1): FlatSymbolic {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.polyPoints = Float32Array.from(Array.from({ length: count }, (_, i) => [i, 0, i + 1, 0]).flat());
  flat.polyStart = Uint32Array.from({ length: count + 1 }, (_, i) => i * 2);
  flat.polyOwner = Uint32Array.from({ length: count }, (_, i) => i + 2);
  flat.polyWorldY = Float32Array.from({ length: count }, () => Number.NaN);
  flat.polyFlags = new Uint8Array(count);
  flat.polyType = new Uint16Array(count);
  return flat;
}
function mixedPrimitives(): FlatSymbolic {
  const flat = lines(2); flat.typeNames.push('IfcGridAxis'); flat.polyType[1] = 1;
  flat.textContent = ['private authored fixture']; flat.textAlignment = ['bottom-left'];
  flat.textX = Float32Array.of(1); flat.textY = Float32Array.of(2);
  flat.textDirX = Float32Array.of(1); flat.textDirY = Float32Array.of(0);
  flat.textHeight = Float32Array.of(1); flat.textTargetPx = Float32Array.of(0);
  flat.textColor = Float32Array.of(0, 0, 0, 1); flat.textOwner = Uint32Array.of(2);
  flat.textWorldY = Float32Array.of(Number.NaN); flat.textType = Uint16Array.of(0);
  flat.fillPoints = Float32Array.of(0, 0, 1, 0, 0, 1); flat.fillPointStart = Uint32Array.of(0, 6);
  flat.fillHoleStart = Uint32Array.of(0, 0); flat.fillColor = Float32Array.of(1, 0, 0, 1);
  flat.fillHatch = Float32Array.of(0, 0, Number.NaN, 0); flat.fillOwner = Uint32Array.of(3);
  flat.fillGeometryItem = Uint32Array.of(7); flat.fillWorldY = Float32Array.of(Number.NaN);
  flat.fillFlags = Uint8Array.of(0); flat.fillType = Uint16Array.of(1);
  return flat;
}

function geometry(): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  return { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: {
    originShift: { x: 0, y: 3, z: 0 }, originalBounds: bounds, shiftedBounds: bounds,
    hasLargeCoordinates: true, wasmRtcOffset: { x: 0, y: 0, z: 10 },
    wasmRtcFrame: { x: 0, y: 0, z: 10, needsShift: true },
  } };
}
function room(value: IfcDataStore, portable: IfcDataStore): RoomSymbolicSource {
  const source: RoomSymbolicSource = {
    dataStore: portable, source: portable.source, seededIds: new Set([2]), ownerIds: new Map([[2, 42]]),
    placements: new Map(), baselines: new Map(), structuredPsets: new Map(), structuredQuantities: new Map(), structuredAttributes: new Map(),
  };
  registerRoomSymbolicSource(value, source);
  return source;
}

function hierarchy(elementToStorey = new Map<number, number>()): SpatialHierarchy {
  return {
    project: { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'lifecycle fixture', children: [], elements: [] },
    byStorey: new Map(), byBuilding: new Map(), bySite: new Map(), bySpace: new Map(),
    storeyElevations: new Map(), storeyHeights: new Map(), elementToStorey,
    getStoreyElements: () => [], getStoreyByElevation: () => null,
    getContainingSpace: () => null, getPath: () => [],
  };
}

describe('canonical symbolic parse completion census (#6537)', () => {
  it('distinguishes genuine successful empty from failure-cached empty, preserving dedupe and cleanup', async () => {
    const empty = store('empty'); select(empty);
    assert.equal(outcome().phase, 'unobserved');
    const job = Promise.all(ensureParseFor([empty]));
    const worker = await posted();
    assert.equal(outcome().phase, 'inflight');
    worker.reply(); await job;
    assert.equal(terminal().completion.kind, 'success');
    assert.equal(census().status, 'complete');
    assert.equal(worker.terminated, 1);
    const emptyResult = getParseFor(empty);
    assert.ok(emptyResult);
    assert.equal(emptyResult.loose.length, 0);
    const firstEpoch = terminal().epoch;
    assert.equal(ensureParseFor([empty]).length, 0, 'observer must retain canonical dedupe');
    assert.equal(terminal().epoch, firstEpoch, 'reads/cache hits are not completions');

    workers = [];
    const failed = store('failed'); select(failed);
    const failedJob = Promise.all(ensureParseFor([failed]));
    const failedWorker = await posted();
    failedWorker.onmessage?.({ data: { id: failedWorker.posted[0].id, ok: false, error: 'private IFC text must not enter the census' } });
    await failedJob;
    assert.equal(getParseFor(failed)?.loose.length, 0, 'existing empty-on-failure rendering remains');
    assert.equal(terminal().completion.kind, 'failure');
    assert.equal(census().status, 'refused');
    assert.deepEqual(terminal().completion, { kind: 'failure' }, 'bounded category, no private error text');
    assert.ok(terminal().epoch > firstEpoch);
    assert.equal(ensureParseFor([failed]).length, 0, 'failure must not reopen the retry storm');
    assert.equal(failedWorker.terminated, 1);
  });

  for (const failure of ['crash', 'message-error', 'timeout', 'constructor', 'post', 'handoff'] as const) {
    it(`refuses actual ${failure} failure while settling the canonical job`, async () => {
      const value = store(failure); select(value);
      if (failure === 'constructor') __setOverlayWorkerFactoryForTest(() => { throw new Error('controlled CSP refusal'); });
      if (failure === 'post') __setOverlayWorkerFactoryForTest(() => {
        const worker = new HeldWorker(); worker.failPost = true; workers.push(worker); return worker as unknown as Worker;
      });
      if (failure === 'handoff') {
        const source = value.source;
        value.source = new Proxy(source, { get(target, key) {
          if (key === 'toTransferable') return () => { throw new Error('controlled detached source'); };
          const member: unknown = Reflect.get(target, key, target);
          return typeof member === 'function' ? member.bind(target) : member;
        } });
      }
      if (failure === 'timeout') mock.timers.enable({ apis: ['setTimeout'] });
      const job = Promise.all(ensureParseFor([value]));
      if (failure === 'crash' || failure === 'message-error' || failure === 'timeout') {
        const worker = await posted();
        if (failure === 'crash') worker.onerror?.({ message: 'controlled worker death' });
        if (failure === 'message-error') worker.onmessageerror?.();
        if (failure === 'timeout') mock.timers.tick(JOB_TIMEOUT_MS + 1);
      }
      await job;
      assert.equal(terminal().completion.kind, 'failure');
      assert.equal(census().status, 'refused');
      assert.equal(ensureParseFor([value]).length, 0);
      for (const worker of workers) assert.ok(worker.terminated > 0, 'failed actual worker must be disposed');
    });
  }

  it('preserves old drawing consumer empty-on-failure projection through the same dispatch', async () => {
    const promise = parseSymbolicFlat(store('drawing').source.toTransferable(), false, 'all');
    const worker = await posted(); worker.onerror?.({ message: 'controlled drawing worker failure' });
    const flat = await promise;
    assert.equal(flat.polyOwner.length + flat.textOwner.length + flat.fillOwner.length, 0);
    assert.equal(worker.terminated, 1);
  });

  it('records canonical prefilter skip and rejects in-place owner-index refresh until producer reruns', async () => {
    const value = store('prefilter', false); select(value);
    await Promise.all(ensureParseFor([value]));
    assert.deepEqual(terminal().completion, { kind: 'skip', reason: 'no-owner-types' });
    assert.equal(census().status, 'complete');
    assert.equal(workers.length, 0, 'the skip must not create a worker');
    value.entityIndex.byType.set('IFCANNOTATION', [2]);
    assert.equal(outcome().phase, 'stale');
    const job = Promise.all(ensureParseFor([value]));
    (await posted()).reply(lines()); await job;
    assert.equal(terminal().completion.kind, 'success');
    assert.equal(getParseFor(value)?.loose.length, 1);
  });

  it('keeps in-flight visible during actual notification, then exposes bucketed nonempty counts after finally', async () => {
    const value = store('nonempty'); select(value);
    const phases: string[] = [];
    const unsubscribe = subscribeToParseCache(() => phases.push(outcome().phase));
    try {
      const job = Promise.all(ensureParseFor([value]));
      (await posted()).reply(mixedPrimitives()); await job;
      assert.deepEqual(phases, ['inflight'], 'notify precedes canonical finally cleanup');
      const observed = terminal();
      assert.ok(observed.census.status === 'complete');
      assert.deepEqual(observed.census.annotation, { lines: 1, texts: 1, fills: 0 });
      assert.deepEqual(observed.census.grid, { lines: 1, texts: 0, fills: 1 });
      assert.equal(getParseFor(value)?.loose[0]?.line.end.x, 1, 'real bucketer retained the independently supplied segment');
    } finally { unsubscribe(); }
  });

  it('refuses in-place RTC/rebase mutations and hierarchy revision changes without initiating work', async () => {
    const value = store('frame'); const model = fixtureModel('m'); const result = geometry();
    model.ifcDataStore = value; model.geometryResult = result; model.loadState = 'complete';
    useViewerStore.setState({ models: new Map([['m', model]]) });
    const job = Promise.all(ensureParseFor([value])); (await posted()).reply(lines()); await job;
    assert.equal(census().status, 'complete');
    const info = result.coordinateInfo;
    assert.ok(info.wasmRtcFrame); info.wasmRtcFrame.z++;
    assert.equal(outcome().phase, 'stale'); info.wasmRtcFrame.z--;
    info.originShift.y++; assert.equal(outcome().phase, 'stale'); info.originShift.y--;
    useViewerStore.setState({ mutationVersion: 1 }); assert.equal(outcome().phase, 'stale');
    assert.equal(workers.length, 1, 'passive reads cannot trigger a reparse');
    model.loadState = 'streaming-geometry'; delete info.wasmRtcFrame;
    assert.equal(outcome().phase, 'pending-frame');
  });

  it('does not hash/copy source or rebuild live spatial data on a passive read, including an unobserved source', async () => {
    const value = store('passive'); select(value);
    const source = value.source;
    let reads = 0;
    value.source = new Proxy(source, { get(target, key) {
      if (key === 'contentKey' || key === 'toTransferable' || key === 'materialize' || key === 'slice') reads++;
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.equal(outcome().phase, 'unobserved'); assert.equal(reads, 0);
    const job = Promise.all(ensureParseFor([value])); (await posted()).reply(); await job;
    const priorReads = reads;
    const beforeState = useViewerStore.getState();
    for (let i = 0; i < 10; i++) assert.equal(census().status, 'complete');
    assert.equal(reads, priorReads, 'observer cannot invoke lazy hash/materialization/handoff');
    assert.ok(useViewerStore.getState() === beforeState, 'observer cannot write the store');
    value.source = source; assert.equal(outcome().phase, 'stale', 'source replacement is not certified by old evidence');
  });

  it('uses the real passive page callback and refuses mutation-view/map rebinding without walking them', async () => {
    const value = store('private-consumer'); select(value); const spatial = hierarchy(); value.spatialHierarchy = spatial;
    const view = new MutablePropertyView(null, '__legacy__');
    useViewerStore.setState({ mutationViews: new Map([['__legacy__', view]]) });
    const job = Promise.all(ensureParseFor([{ store: value, mutationView: view }])); (await posted()).reply(); await job;
    // Dynamic URL import preserves the actual JS page callback without a fabricated TS declaration.
    const module: unknown = await import(new URL('../../../../scripts/perf/symbolic-parse-census.mjs', import.meta.url).href);
    const callback = (module as { readSymbolicParseOutcomeCensus: () => unknown }).readSymbolicParseOutcomeCensus;
    assert.deepEqual(callback(), census(), 'actual callback must use the viewer store consumer');
    assert.equal(census().status, 'complete');
    // A read must not try the effective-spatial graph or touch a mutation view.
    const originalPending = view.hasPendingChanges;
    view.hasPendingChanges = () => { throw new Error('passive observer walked the mutation view'); };
    try { assert.equal(census().status, 'complete'); } finally { view.hasPendingChanges = originalPending; }
    spatial.elementToStorey = new Map([[2, 99]]);
    assert.equal(outcome().phase, 'stale');
    const replacement = new MutablePropertyView(null, '__legacy__');
    useViewerStore.setState({ mutationViews: new Map([['__legacy__', replacement]]) });
    assert.equal(outcome().phase, 'stale');
    assert.equal(workers.length, 1);
  });

  it('retains the existing result LRU and monotonic completion epoch across eviction and clear', async () => {
    const first = store('eviction-first', false); select(first); await Promise.all(ensureParseFor([first]));
    const initialEpoch = terminal().epoch;
    for (let i = 0; i < 32; i++) await Promise.all(ensureParseFor([store(`eviction-${i}`, false)]));
    assert.equal(outcome().phase, 'evicted', 'weak completion evidence must not resurrect evicted results');
    __resetSymbolicAnnotationsCacheForTests();
    await Promise.all(ensureParseFor([first]));
    assert.ok(terminal().epoch > initialEpoch, 'a normal clear must not reset the live-session fence');
  });

  it('refuses overbudget bucket census without modifying or truncating the actual parsed result', async () => {
    const value = store('bucket-budget'); select(value);
    const count = 4097;
    value.spatialHierarchy = hierarchy(new Map(Array.from({ length: count }, (_, i) => [i + 2, i + 10000] as const)));
    value.spatialHierarchy.storeyElevations = new Map(Array.from({ length: count }, (_, i) => [i + 10000, i] as const));
    const job = Promise.all(ensureParseFor([value])); (await posted()).reply(lines(count)); await job;
    assert.equal(getParseFor(value)?.byStorey.size, count, 'observation budget cannot truncate real output');
    assert.deepEqual(terminal().census, { status: 'refused', reason: 'bucket-budget' });
    assert.equal(census().status, 'refused');
  });

  it('records actual room completion/skip and refuses rebound room identity without parsing', async () => {
    const portable = store('room'); const value = store('reconstruction'); select(value);
    room(value, portable);
    const job = Promise.all(ensureParseFor([value])); (await posted()).reply(lines()); await job;
    assert.equal(terminal().completion.kind, 'success');
    assert.equal(getParseFor(value)?.loose[0]?.ownerId, 42, 'canonical room remapping still runs');
    room(value, portable); assert.equal(outcome().phase, 'stale');
    const skipPortable = store('room-skip', false); const skipped = store('room-synthetic'); select(skipped); room(skipped, skipPortable);
    await Promise.all(ensureParseFor([skipped]));
    assert.deepEqual(terminal().completion, { kind: 'skip', reason: 'no-owner-types' });
    assert.equal(workers.length, 1, 'room skip cannot launch another worker');
  });

  it('preserves room failure memoization as failed evidence rather than successful empty', async () => {
    const portable = store('room-failure'); const value = store('room-failed-reconstruction'); select(value); room(value, portable);
    const job = Promise.all(ensureParseFor([value])); const worker = await posted();
    worker.onerror?.({ message: 'controlled room worker crash' }); await job;
    assert.equal(getParseFor(value)?.loose.length, 0);
    assert.equal(terminal().completion.kind, 'failure');
    assert.equal(census().status, 'refused');
    assert.equal(ensureParseFor([value]).length, 0, 'room cached failure must not launch a retry');
    assert.ok(worker.terminated > 0);
  });

  it('refuses an unloaded federation member and model census overflow through actual store consumer', async () => {
    const complete = fixtureModel('ready'); const federated = store('federation', false); complete.ifcDataStore = federated;
    const unloaded = fixtureModel('pending'); unloaded.ifcDataStore = null;
    useViewerStore.setState({ models: new Map([['ready', complete], ['pending', unloaded]]) });
    await Promise.all(ensureParseFor([federated]));
    assert.equal(census().status, 'refused');
    assert.equal(census().models[1].outcome.phase, 'unobserved');
    useViewerStore.setState({ models: new Map(Array.from({ length: 129 }, (_, i) => [`m${i}`, fixtureModel(`m${i}`)] as const)) });
    assert.equal(census().reason, 'model-budget');
    assert.equal(census().models.length, 0, 'overbudget census must not present a partial success');
  });
});
