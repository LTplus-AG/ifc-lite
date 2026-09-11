/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { buildSpatialIndexForModel, buildSpatialIndexGuarded, invalidateSpatialIndex } from '@/utils/loadingUtils';
import { emptyPlacementState } from './state';

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
  await Promise.resolve();
  const index = useViewerStore.getState().models.get('m')!.ifcDataStore!.spatialIndex;
  assert.ok(index);
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
  await Promise.resolve();
  assert.deepEqual(data.spatialIndex?.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), [1]);
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
  await Promise.resolve();
  assert.deepEqual(data.spatialIndex?.queryAABB({ min: [-1, -1, -1], max: [2, 2, 2] }), [1]);
});
