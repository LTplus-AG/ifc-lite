/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { useIfcFederation } from './useIfcFederation.js';
import { useVisibilityState } from './useViewerSelectors.js';
import { modelHiddenEntities } from '@/lib/visibility/model-hidden-entities.js';

const original = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(original, true);
  federationRegistry.clear();
});

// Invariant: a model's parsed entity table, globally addressed geometry and
// registered local-ID range must keep the same owner after another model leaves.
function model(id: string, expressId: number): FederatedModel {
  const idOffset = federationRegistry.registerModel(id, expressId);
  const geometryResult: GeometryResult = {
    meshes: [{ expressId: federationRegistry.toGlobalId(id, expressId),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalVertices: 3, totalTriangles: 1,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    },
  };
  return {
    id, name: id, idOffset, maxExpressId: expressId, geometryResult,
    ifcDataStore: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0,
      entities: [{ expressId, type: 'IfcWall', name: id, hasGeometry: true }] }),
    visible: true, collapsed: false, schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0,
  };
}

function seed(models: FederatedModel[], active: FederatedModel) {
  useViewerStore.setState({ models: new Map(models.map(item => [item.id, item])),
    activeModelId: active.id, ifcDataStore: active.ifcDataStore,
    geometryResult: active.geometryResult, hiddenEntities: new Set(),
    isolatedEntities: null, ghostExceptEntities: null });
}

function mountFederation() {
  let api: ReturnType<typeof useIfcFederation> | undefined;
  function Probe() {
    api = useIfcFederation(async () => { throw new Error('Removal must not load a file'); });
    return null;
  }
  render(<Probe />);
  assert.ok(api);
  return api;
}

for (const firstId of [2035, 7]) {
  it(`#7890: removing a non-active model preserves a hidden active model (first ID ${firstId})`, () => {
    federationRegistry.clear();
    const first = model('first', firstId), active = model('active', 7), removed = model('removed', 10);
    active.visible = false;
    seed([first, active, removed], active);
    const api = mountFederation();
    act(() => api.removeModel(removed.id));

    const state = useViewerStore.getState();
    // This is the original incident's selector path. Before the fix, the
    // 2035 row was copied into a model whose published local range ended at 7.
    const hidden = modelHiddenEntities(state.models, state.hiddenEntities, state.toGlobalId);
    const ownId = federationRegistry.toGlobalId(active.id, 7);
    assert.deepEqual(hidden, new Set([ownId]));
    assert.equal(state.activeModelId, active.id);
    assert.equal(state.models.get(active.id)?.ifcDataStore, active.ifcDataStore);
    assert.equal(state.models.get(active.id)?.geometryResult, active.geometryResult);
    assert.equal(state.ifcDataStore, active.ifcDataStore);
    assert.equal(state.geometryResult, active.geometryResult);
    assert.equal(state.models.get(first.id), first);
    assert.equal(federationRegistry.hasModel(removed.id), false);
    assert.throws(() => state.toGlobalId(active.id, 2035), /not published/,
      'removing a model must not broaden another model\'s publication');

    let visibleMask: Set<number> | undefined;
    function VisibilityProbe() { visibleMask = useVisibilityState().hiddenEntities; return null; }
    render(<VisibilityProbe />);
    assert.deepEqual(visibleMask, new Set([ownId]));
    act(() => useViewerStore.getState().setModelVisibility(active.id, true));
    assert.deepEqual(visibleMask, new Set());
  });
}

it('#7890: removing an unknown model does not replace the active model or its geometry', () => {
  federationRegistry.clear();
  const first = model('first', 2035), active = model('active', 7);
  seed([first, active], active);
  const api = mountFederation(), before = useViewerStore.getState();
  act(() => api.removeModel('not-loaded'));
  const after = useViewerStore.getState();
  assert.equal(after.models, before.models);
  assert.equal(after.ifcDataStore, active.ifcDataStore);
  assert.equal(after.geometryResult, active.geometryResult);
  assert.equal(after.geometryUpdateTick, before.geometryUpdateTick);
});

for (const count of [1, 2]) {
  it(`#7890: removing the active model follows the store's successor (${count} models)`, () => {
    federationRegistry.clear();
    const active = model('active', 7);
    const survivors = count === 2 ? [model('survivor', 2035)] : [];
    seed([active, ...survivors], active);
    const api = mountFederation();
    act(() => api.removeModel(active.id));
    const state = useViewerStore.getState(), next = survivors[0];
    assert.equal(state.activeModelId, next?.id ?? null);
    assert.equal(state.ifcDataStore, next?.ifcDataStore ?? null);
    assert.equal(state.geometryResult, next?.geometryResult ?? null);
    assert.equal(state.models.size, count - 1);
    assert.equal(federationRegistry.hasModel(active.id), false);
  });
}
