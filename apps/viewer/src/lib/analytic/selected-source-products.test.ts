/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { loadSelectedSourceGroups, selectedSourceProducts } from './selected-source-products.js';

it('uses the exact model-aware basket and skips a federated GLB compatibility store (#6432)', () => {
  const ifc = fixtureModel('ifc', { idOffset: 1_000_000 });
  const glb = fixtureModel('glb', { idOffset: 2_000_000 });
  Object.assign(ifc.ifcDataStore!, { source: { byteLength: 1 } });
  ifc.loadFormat = 'ifc';
  glb.loadFormat = 'glb';
  glb.sourceFile = new File(['glTF'], 'geometry.glb');
  const state = { ...useViewerStore.getState(), models: new Map([[ifc.id, ifc], [glb.id, glb]]),
    selectedEntity: { modelId: 'ifc', expressId: 2 },
    selectedEntitiesSet: new Set(['ifc:1', 'glb:1']),
    // Both primary and renderer ID are stale after removing a product from a multi-model basket.
    selectedEntityId: 1_000_002, selectedEntityIds: new Set([1_000_002]),
    toGlobalId: (modelId: string, expressId: number) =>
      (modelId === 'ifc' ? 1_000_000 : 2_000_000) + expressId,
  };
  const selection = selectedSourceProducts(state, 'extrusion inspection', () => {
    throw new Error('legacy resolver must not read stale renderer IDs');
  });
  assert.deepEqual([...selection.grouped], [['ifc', [1]]]);
  assert.deepEqual(selection.overlayRefs, []);

  // detectFormat is content-based: a valid IFC can arrive under any filename.
  Object.assign(ifc.ifcDataStore!, { source: { byteLength: 0 } });
  ifc.sourceFile = new File(['ISO-10303-21'], 'uploaded-model.bin');
  assert.deepEqual([...selectedSourceProducts(state, 'extrusion inspection', () => {
    throw new Error('stale renderer ID must stay ignored');
  }).grouped], [['ifc', [1]]]);

  const missingSource = fixtureModel('no-source', { idOffset: 3_000_000 });
  const withoutBytes = { ...state, models: new Map([[missingSource.id, missingSource]]),
    selectedEntity: { modelId: 'no-source', expressId: 1 },
    selectedEntitiesSet: new Set(['no-source:1']) };
  assert.equal(selectedSourceProducts(withoutBytes, 'extrusion inspection', () => {
    throw new Error('model-aware selection must not invoke legacy resolution');
  }).grouped.size, 0);
});

it('keeps the single-model legacy globalId equals expressId fallback (#6432)', () => {
  const store = fixtureDataStore([{ expressId: 7, type: 'IfcWall' }]);
  Object.assign(store, { source: { byteLength: 1 } });
  const state = { ...useViewerStore.getState(), models: new Map(), ifcDataStore: store,
    selectedEntity: null, selectedEntitiesSet: new Set<string>(),
    selectedEntityId: 7, selectedEntityIds: new Set<number>(),
  };
  const selection = selectedSourceProducts(state, 'extrusion inspection', (id) => ({ modelId: 'legacy', expressId: id }));
  assert.deepEqual([...selection.grouped], [['legacy', [7]]]);
});

it('retains valid model records when another model source rejects (#6432)', async () => {
  const result = await loadSelectedSourceGroups(new Map([['bad', [1]], ['good', [2]]]),
    async (modelId) => {
      if (modelId === 'bad') throw new Error('source read failed');
      return [{ modelId, expressId: 2 }];
    });
  assert.deepEqual(result.items, [{ modelId: 'good', expressId: 2 }]);
  assert.deepEqual(result.errors, ['model bad: Error: source read failed']);
});
