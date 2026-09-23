/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore, type FederatedModel } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { buildSpatialIndexForModel, buildSpatialIndexGuarded, invalidateSpatialIndex } from '@/utils/loadingUtils';
import { emptyPlacementState } from './state';
import { buildPlacedSpatialIndex } from './spatial-index';
import { modelIndices } from './model-indices';

/** The production BVH yields between build phases; await publication, not a microtask count. */
async function waitForPublication<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

it('publishes spatial queries at the moved position and prevents a late source build restoring old coordinates (#4226)', async () => {
  const model = fixtureModel('m'), data = model.ifcDataStore!;
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState() });
  buildSpatialIndexForModel([mesh], 'm', data);
  const s = useViewerStore.getState();
  s.openReposition(['m']); s.previewModelTranslation([10, 20, 30]); s.applyModelTranslation();
  invalidateSpatialIndex(data);
  await Promise.resolve();
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
  buildSpatialIndexGuarded([mesh], data, (ifcDataStore) => useViewerStore.setState({ ifcDataStore }));
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
  const fakeRenderer = { getScene: () => ({ getAllInstancedMeshData: () => [occA, occB] }) } as unknown as Renderer;
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
