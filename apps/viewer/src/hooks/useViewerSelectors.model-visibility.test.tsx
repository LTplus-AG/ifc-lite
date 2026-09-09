/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useVisibilityState } from './useViewerSelectors.js';
import { loadedInstancedModelIndices, modelHiddenEntities } from '@/lib/visibility/model-hidden-entities.js';

const original = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(original);
  federationRegistry.clear();
});

function model(id: string) {
  const result = fixtureModel(id);
  result.ifcDataStore = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
    { expressId: 7, type: 'IfcMember', hasGeometry: true },
    { expressId: 8, type: 'IfcMember', hasGeometry: true },
    { expressId: 9, type: 'IfcRelAggregates' },
  ] });
  return result;
}

for (const count of [1, 2]) {
  it(`#4428: model hide/show masks instance-only owners and preserves user hide/isolation (${count} models)`, () => {
    federationRegistry.clear();
    const models = Array.from({ length: count }, (_, i) => model(`m${i}`));
    for (const item of models) item.idOffset = federationRegistry.registerModel(item.id, 100);
    const target = models[count - 1];
    const owner = federationRegistry.toGlobalId(target.id, 7);
    const manuallyHidden = federationRegistry.toGlobalId(target.id, 8);
    const userHidden = new Set([manuallyHidden]);
    const isolation = new Set([owner]);
    useViewerStore.setState({ ...fixtureModels(...models), hiddenEntities: userHidden,
      isolatedEntities: isolation, ghostExceptEntities: null });
    let observed = emptyVisibilitySnapshot();
    function Probe() { observed = useVisibilityState(); return null; }
    render(<Probe />);
    assert.deepEqual(observed.hiddenEntities, userHidden);
    act(() => useViewerStore.getState().setModelVisibility(target.id, false));
    assert.equal(observed.hiddenEntities.has(owner), true, 'instance-only owner is masked without optional hashes or flat meshes');
    assert.equal(observed.hiddenEntities.has(federationRegistry.toGlobalId(target.id, 9)), false, 'non-geometric rows do not inflate the mask');
    if (count === 2) assert.equal(observed.hiddenEntities.has(federationRegistry.toGlobalId('m0', 7)), false);
    assert.equal(useViewerStore.getState().hiddenEntities, userHidden, 'derived model mask never takes ownership of user hides');
    assert.equal(observed.isolatedEntities, isolation);
    act(() => useViewerStore.getState().setModelVisibility(target.id, true));
    assert.equal(observed.hiddenEntities, userHidden, 'show restores model visibility while keeping manual hides');
    assert.equal(observed.isolatedEntities, isolation);
  });
}

function emptyVisibilitySnapshot(): ReturnType<typeof useVisibilityState> {
  return { hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null };
}

it('#4428: retain all hidden loaded model indices and release removed ownership', () => {
  const a = model('a'), b = model('b');
  a.visible = false; b.visible = false;
  const models = new Map([['a', a], ['b', b]]);
  const indices = new Map([['a', 1], ['b', 2]]);
  assert.deepEqual(loadedInstancedModelIndices(models, indices), new Set([0, 1, 2]));
  models.delete('b');
  assert.deepEqual(loadedInstancedModelIndices(models, indices), new Set([0, 1]));
  assert.equal(loadedInstancedModelIndices(models, undefined), undefined);
});

it('#4428: hidden masks include overlay/combined owners and optional instance inventories', () => {
  const target = model('m');
  target.visible = false;
  target.geometryResult = {
    meshes: [{ expressId: 100, entityIds: new Uint32Array([101, 102]),
      positions: new Float32Array(9), normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalVertices: 3, totalTriangles: 1,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } },
    instancedGeometryHashes: new Map([[103, 1n]]),
    instancedGeometryAabbs: new Map([[104, { min: [0, 0, 0], max: [1, 1, 1] }]]),
  };
  const registry = federationRegistry;
  registry.clear(); registry.registerModel('m', 200);
  const user = new Set([999]);
  assert.deepEqual(modelHiddenEntities(new Map([['m', target]]), user,
    (modelId, id) => registry.toGlobalId(modelId, id)), new Set([7, 8, 101, 102, 103, 104, 999]));
  assert.deepEqual(user, new Set([999]));
});
