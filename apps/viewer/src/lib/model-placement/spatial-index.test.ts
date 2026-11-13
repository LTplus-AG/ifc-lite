/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore, type FederatedModel } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { buildSpatialIndexForModel, invalidateSpatialIndex } from '@/utils/loadingUtils';
import { emptyPlacementState } from './state';
import { buildPlacedSpatialIndex, createPlacementIndexSync } from './spatial-index';
import { modelIndices } from './model-indices';
import { settle } from '@/test/settle';
import { discardInstancedShards, drainInstancedShards, enqueueInstancedShards, subscribeInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';

afterEach(() => discardInstancedShards());

/** The renderer drain's part, without a renderer: hand the queued shards over. */
const drainToRenderer = () => drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); /* the fake scene already lists the instances */ });

/** `useModelPlacementSync`'s two subscriptions: store updates and shard arrivals/drains. */
function subscribeSync(sync: ReturnType<typeof createPlacementIndexSync>): () => void {
  const offStore = useViewerStore.subscribe((state, previous) => sync.update(state, previous));
  const offShards = subscribeInstancedShards((event) => sync.instancedShards(event, useViewerStore.getState()));
  return () => { offStore(); offShards(); };
}

/** A fake renderer's scene with nothing streaming or finalizing: the placement
 * index builds only once the scene has settled (`isSceneSettled`). */
const SETTLED_SCENE = { hasQueuedMeshes: () => false, hasStreamingFragments: () => false, isFinalizeInProgress: () => false };

/** The production BVH yields between build phases; await publication, not a microtask count. */
async function waitForPublication<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Let the placement sync's 200 ms debounce timer fire and any build it starts
 * finish, so a following "nothing was (re)built" assertion is not vacuous on
 * a loaded runner. Node fires timers in deadline order, so this 250 ms timer,
 * armed after the debounce, can never run before it however slow the machine
 * is; the BVH build it would start yields only through setTimeout(0), which
 * `settle`'s event-loop turns bound without a wall-clock budget.
 */
async function pastDebounce(message: string): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 250));
  await settle(message);
}

it('publishes spatial queries at the moved position and prevents a late source build restoring old coordinates (#4226)', async () => {
  const model = fixtureModel('m'), data = model.ifcDataStore!;
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  const oldBuild = buildSpatialIndexForModel([mesh], 'm', data);
  const s = useViewerStore.getState();
  s.openReposition(['m']); s.previewModelTranslation([10, 20, 30]); s.applyModelTranslation();
  invalidateSpatialIndex(data);
  await oldBuild; // the superseded build has completed, so the next line is not vacuous
  assert.equal(data.spatialIndex, undefined, 'completion of the old build cannot republish source coordinates');
  buildSpatialIndexForModel([mesh], 'm', data);
  const index = await waitForPublication(
    () => useViewerStore.getState().models.get('m')!.ifcDataStore!.spatialIndex,
    'the replacement placed index',
  );
  assert.deepEqual(index.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), []);
  assert.deepEqual(index.queryAABB({ min: [9, 29, -21], max: [12, 32, -19] }), [1]);
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 0, 1, 0], 'spatial indexing does not rewrite source vertices');
});

it('waits for GPU shard drain and indexes pure instances for primary and federated models (#5275)', async () => {
  const occurrence = (x: number, id: number, modelIndex: number): MeshData => ({
    expressId: id, modelIndex, positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1],
  } as MeshData);
  const emptyGeometry = { meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 } } } as unknown as GeometryResult;
  const primary = { ...fixtureModel('primary'), idOffset: 0, maxExpressId: 1000,
    geometryResult: emptyGeometry, loadState: 'complete' } as FederatedModel;
  const federated = { ...fixtureModel('federated'), idOffset: 1000, maxExpressId: 1000,
    geometryResult: emptyGeometry, loadState: 'complete' } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(primary, federated), modelPlacement: emptyPlacementState() });
  enqueueInstancedShards('primary', [new ArrayBuffer(1)], instancedShardGeneration());
  enqueueInstancedShards('federated', [new ArrayBuffer(1)], instancedShardGeneration());
  const rendererIndices = modelIndices(useViewerStore.getState().models);
  const instances = [occurrence(20, 156, rendererIndices.get('primary')!),
    occurrence(50, 1156, rendererIndices.get('federated')!)];
  let materializations = 0;
  const fakeRenderer = { getScene: () => ({ ...SETTLED_SCENE, getAllInstancedMeshData: () => { materializations++; return instances; } }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);
  const sync = createPlacementIndexSync();
  const unsubscribe = subscribeSync(sync);
  try {
    sync.refreshMissing(useViewerStore.getState());
    await pastDebounce('a pending shard schedules no index build');
    assert.equal(primary.ifcDataStore!.spatialIndex, undefined, 'pending primary shard must block a flat-only index');
    assert.equal(federated.ifcDataStore!.spatialIndex, undefined, 'pending federated shard must block a flat-only index');
    drainToRenderer();
    const first = await waitForPublication(() => primary.ifcDataStore!.spatialIndex, 'primary instance index');
    const second = await waitForPublication(() => federated.ifcDataStore!.spatialIndex, 'federated instance index');
    assert.deepEqual(first.queryAABB({ min: [20, 0, 0], max: [21, 1, 0] }), [156]);
    assert.deepEqual(first.queryAABB({ min: [50, 0, 0], max: [51, 1, 0] }), []);
    assert.deepEqual(second.queryAABB({ min: [50, 0, 0], max: [51, 1, 0] }), [1156]);
    assert.deepEqual(second.queryAABB({ min: [20, 0, 0], max: [21, 1, 0] }), []);
    assert.equal(materializations, 2, 'each model materializes once');
    useViewerStore.setState({ selectedEntityId: 156 });
    await pastDebounce('a selection change schedules no rebuild');
    assert.equal(materializations, 2, 'ordinary selection updates do not rematerialize instances');
    enqueueInstancedShards('primary', [new ArrayBuffer(1)], instancedShardGeneration());
    assert.equal(primary.ifcDataStore!.spatialIndex, undefined, 'a late shard withdraws the incomplete index');
    instances.push(occurrence(80, 157, rendererIndices.get('primary')!));
    drainToRenderer();
    const rebuilt = await waitForPublication(() => primary.ifcDataStore!.spatialIndex, 'late primary shard index');
    assert.deepEqual(rebuilt.queryAABB({ min: [80, 0, 0], max: [81, 1, 0] }), [157]);
    assert.equal(materializations, 3, 'the late primary shard rebuilds only its owner');
  } finally {
    unsubscribe(); sync.dispose();
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});

it('reschedules an index after placement sync remount cancels a pending timer (#5275)', async () => {
  const mesh: MeshData = { expressId: 5, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('remount'), maxExpressId: 5, loadState: 'complete',
    geometryResult: { meshes: [mesh], totalTriangles: 1 } as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  const sync = createPlacementIndexSync();
  try {
    sync.refreshMissing(useViewerStore.getState());
    sync.dispose();
    sync.refreshMissing(useViewerStore.getState());
    const index = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'index after remount');
    assert.deepEqual(index.queryAABB({ min: [0, 0, 0], max: [1, 1, 0] }), [5]);
  } finally { sync.dispose(); }
});

it('rebuilds when a placement restore lands between sync subscriptions (#5275)', async () => {
  const mesh: MeshData = { expressId: 5, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('restored'), maxExpressId: 5, loadState: 'complete',
    geometryResult: { meshes: [mesh], totalTriangles: 1,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
        shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } } } as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  const sync = createPlacementIndexSync();
  try {
    sync.refreshMissing(useViewerStore.getState());
    const old = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'pre-restore index');
    sync.dispose(); // React cleans up this effect before persistence restores placement.
    const state = useViewerStore.getState();
    state.openReposition(['restored']); state.previewModelTranslation([10, 20, 30]); state.applyModelTranslation();
    sync.refreshMissing(useViewerStore.getState());
    assert.equal(model.ifcDataStore!.spatialIndex, undefined, 'old position is withdrawn immediately');
    const rebuilt = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'restored-position index');
    assert.notEqual(rebuilt, old);
    assert.deepEqual(rebuilt.queryAABB({ min: [9, 29, -21], max: [12, 32, -19] }), [5]);
    assert.deepEqual(rebuilt.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), []);
  } finally { sync.dispose(); }
});

it('indexes a drained instance when its data store arrives afterward (#5275)', async () => {
  const model = { ...fixtureModel('late-store'), ifcDataStore: null, idOffset: 0, maxExpressId: 10,
    loadState: 'complete', geometryResult: { meshes: [], totalTriangles: 0 } as unknown as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  enqueueInstancedShards('late-store', [new ArrayBuffer(1)], instancedShardGeneration());
  const mesh = { expressId: 7, modelIndex: modelIndices(useViewerStore.getState().models).get('late-store')!,
    positions: new Float32Array([30, 0, 0, 31, 0, 0, 30, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] } as MeshData;
  const fakeRenderer = { getScene: () => ({ ...SETTLED_SCENE, getAllInstancedMeshData: () => [mesh] }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);
  const sync = createPlacementIndexSync();
  const unsubscribe = subscribeSync(sync);
  try {
    sync.refreshMissing(useViewerStore.getState());
    drainToRenderer();
    await pastDebounce('a model without a data store builds no index');
    const data = fixtureModel('late-store').ifcDataStore!;
    assert.equal(data.spatialIndex, undefined);
    useViewerStore.getState().updateModel('late-store', { ifcDataStore: data });
    const index = await waitForPublication(() => data.spatialIndex, 'late data-store instance index');
    assert.deepEqual(index.queryAABB({ min: [30, 0, 0], max: [31, 1, 0] }), [7]);
  } finally {
    unsubscribe(); sync.dispose();
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});

it('replaces a flat index when an instance drains during placement-sync remount (#5275)', async () => {
  const flat: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('missed-shard'), maxExpressId: 10, loadState: 'complete',
    geometryResult: { meshes: [flat], totalTriangles: 1 } as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  const pieces: MeshData[] = [];
  const fakeRenderer = { getScene: () => ({ ...SETTLED_SCENE, getAllInstancedMeshData: () => pieces }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);
  const sync = createPlacementIndexSync();
  try {
    sync.refreshMissing(useViewerStore.getState());
    const flatIndex = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'flat index');
    assert.deepEqual(flatIndex.queryAABB({ min: [40, 0, 0], max: [41, 1, 0] }), []);
    sync.dispose();
    enqueueInstancedShards('missed-shard', [new ArrayBuffer(1)], instancedShardGeneration());
    pieces.push({ expressId: 7, modelIndex: modelIndices(useViewerStore.getState().models).get('missed-shard')!,
      positions: new Float32Array([40, 0, 0, 41, 0, 0, 40, 1, 0]),
      indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] } as MeshData);
    drainToRenderer();
    sync.refreshMissing(useViewerStore.getState());
    assert.equal(model.ifcDataStore!.spatialIndex, undefined, 'flat index is withdrawn after missed shard drain');
    const complete = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'complete instance index');
    assert.deepEqual(complete.queryAABB({ min: [40, 0, 0], max: [41, 1, 0] }), [7]);
  } finally {
    sync.dispose(); setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});

it('retries the same model revision after an asynchronous index build fails (#5275 review)', async () => {
  const mesh: MeshData = { expressId: 9, positions: null as unknown as Float32Array,
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('retry-index'), maxExpressId: 9, loadState: 'complete',
    geometryResult: { meshes: [mesh], totalTriangles: 1 } as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  const sync = createPlacementIndexSync();
  const originalWarn = console.warn;
  let failed = false;
  console.warn = (...args: unknown[]) => { if (String(args[0]).includes('Failed to build spatial index for model')) failed = true;
    else originalWarn(...args); };
  try {
    sync.refreshMissing(useViewerStore.getState());
    await waitForPublication(() => failed || undefined, 'failed first index build');
    assert.equal(model.ifcDataStore!.spatialIndex, undefined);
    mesh.positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    sync.refreshMissing(useViewerStore.getState());
    const index = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'retry index');
    assert.deepEqual(index.queryAABB({ min: [0, 0, 0], max: [1, 1, 0] }), [9]);
  } finally { sync.dispose(); console.warn = originalWarn; }
});

it('publishes an IFC index when scan alignment changes during the build (#4226)', async () => {
  const model = fixtureModel('m'), data = model.ifcDataStore!;
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState(), pointCloudAlignmentEnabled: false });
  buildSpatialIndexForModel([mesh], 'm', data);
  useViewerStore.setState({ pointCloudAlignmentEnabled: true });
  const index = await waitForPublication(() => data.spatialIndex, 'the alignment index');
  assert.deepEqual(index.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), [1]);
});

for (const remove of [false, true]) it(`publishes the primary index while an unrelated model changes (remove: ${remove}, #4226)`, async () => {
  const model = fixtureModel('primary'), data = model.ifcDataStore!;
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  useViewerStore.setState({ ...fixtureModels(model, fixtureModel('other')), ifcDataStore: data, modelPlacement: emptyPlacementState() });
  buildSpatialIndexForModel([mesh], 'primary', data);
  const state = useViewerStore.getState();
  if (remove) useViewerStore.setState({ models: new Map([['primary', model]]) });
  else { state.openReposition(['other']); state.previewModelTranslation([100, 0, 0]); }
  const index = await waitForPublication(() => data.spatialIndex, 'the primary index');
  assert.deepEqual(index.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), [1]);
});

/**
 * #4890 review: `withInstancedMeshes` used to filter `getAllInstancedMeshData()`
 * by global-id range alone. Two federated models CAN share an overlapping
 * range (a collab-joined model re-using an id space a normally loaded model
 * already occupies) — deliberately reproduced here — and without the
 * renderer-model-index filter this added, `buildPlacedSpatialIndex` would
 * splice one model's occurrence into the other's index.
 */
it('does not leak an occurrence into another model\'s index when the two share an overlapping global-id range (#4890 review)', async () => {
  const box = (dx: number, expressId: number, rendererModelIndex: number): MeshData => ({
    expressId, modelIndex: rendererModelIndex, ifcType: 'IfcDoor',
    positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
  } as unknown as MeshData);

  const emptyGeometry = { meshes: [], coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false } } as unknown as GeometryResult;

  // The SAME (0, 1000] global-id bracket for both — deliberately overlapping,
  // e.g. a collab-joined model re-using the range a normally loaded model
  // already occupies.
  const modelA = { ...fixtureModel('a'), idOffset: 0, maxExpressId: 1000, geometryResult: emptyGeometry } as FederatedModel;
  const modelB = { ...fixtureModel('b'), idOffset: 0, maxExpressId: 1000, geometryResult: emptyGeometry } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(modelA, modelB), modelPlacement: emptyPlacementState() });

  const indices = modelIndices(useViewerStore.getState().models);
  const indexA = indices.get('a')!, indexB = indices.get('b')!;
  assert.notEqual(indexA, indexB, 'sanity: the two models must have distinct renderer indices');

  // The SAME expressId too — both models' occurrences fall in the shared
  // bracket, so only the renderer `modelIndex` tells them apart.
  const occA = box(0, 500, indexA), occB = box(50, 500, indexB);
  const fakeRenderer = { getScene: () => ({ ...SETTLED_SCENE, getAllInstancedMeshData: () => [occA, occB] }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);
  try {
    buildPlacedSpatialIndex(useViewerStore.getState(), 'a');
    buildPlacedSpatialIndex(useViewerStore.getState(), 'b');
    const spatialA = await waitForPublication(
      () => useViewerStore.getState().models.get('a')!.ifcDataStore!.spatialIndex,
      "model a's index",
    );
    const spatialB = await waitForPublication(
      () => useViewerStore.getState().models.get('b')!.ifcDataStore!.spatialIndex,
      "model b's index",
    );

    assert.deepEqual(spatialA!.queryAABB({ min: [0, 0, 0], max: [1, 1, 1] }), [500], 'model a must see its own occurrence');
    assert.deepEqual(spatialA!.queryAABB({ min: [50, 0, 0], max: [51, 1, 1] }), [],
      'model a\'s index must not contain model b\'s occurrence from the shared id range');

    assert.deepEqual(spatialB!.queryAABB({ min: [50, 0, 0], max: [51, 1, 1] }), [500], 'model b must see its own occurrence');
    assert.deepEqual(spatialB!.queryAABB({ min: [0, 0, 0], max: [1, 1, 1] }), [],
      'model b\'s index must not contain model a\'s occurrence from the shared id range');
  } finally {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});

it('records the first placed build after a load as that load\'s bvh.build span, and only the first (#6979)', async () => {
  const { createLoadTracer } = await import('@ifc-lite/load-trace');
  const { publishLoadTrace } = await import('@/lib/perf/activeLoadTrace');
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('bvh-traced', tracer.startLoad('bvh-traced'));
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('bvh-traced'), idOffset: 0, maxExpressId: 10,
    geometryResult: { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 } } } } as unknown as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  assert.equal(await buildPlacedSpatialIndex(useViewerStore.getState(), 'bvh-traced'), true);
  assert.equal(await buildPlacedSpatialIndex(useViewerStore.getState(), 'bvh-traced'), true);
  const builds = tracer.latest()!.spans.filter((s) => s.name === 'bvh.build');
  assert.equal(builds.length, 1, 'a rebuild after the load is not recorded on it');
  assert.ok(builds[0].end !== null && builds[0].end >= builds[0].start, 'the span closes when the index publishes');
});

it('builds no placed index while the scene is still draining or finalizing, then builds it once settled (L1)', async () => {
  const mesh: MeshData = { expressId: 5, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  const model = { ...fixtureModel('settling'), maxExpressId: 5, loadState: 'complete',
    geometryResult: { meshes: [mesh], totalTriangles: 1 } as GeometryResult } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  let finalizing = true;
  let materializations = 0;
  const fakeRenderer = { getScene: () => ({ ...SETTLED_SCENE, isFinalizeInProgress: () => finalizing,
    getAllInstancedMeshData: () => { materializations++; return []; } }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);
  const sync = createPlacementIndexSync();
  try {
    sync.refreshMissing(useViewerStore.getState());
    await pastDebounce('a load-complete model whose scene still finalizes');
    await pastDebounce('and a second debounce period');
    assert.ok(model.ifcDataStore!.spatialIndex === undefined, 'no index is built while the scene finalizes');
    assert.ok(materializations === 0, 'no instanced occurrence is materialised during the load');
    finalizing = false;
    const index = await waitForPublication(() => model.ifcDataStore!.spatialIndex, 'the index once the scene settled');
    assert.deepEqual(index.queryAABB({ min: [0, 0, 0], max: [1, 1, 0] }), [5]);
  } finally {
    sync.dispose(); setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});
