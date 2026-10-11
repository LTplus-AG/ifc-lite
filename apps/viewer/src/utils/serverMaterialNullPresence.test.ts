/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { extractAllMaterialsOnDemand } from '@ifc-lite/parser';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { checkMaterialFacet } from '@ifc-lite/ids';
import { exportAndReparse, parseStep, seedModel } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

test('#7211 native SketchUp material list keeps public written null Name resolved before and after STEP export', async () => {
  const source = await readFile(new URL('../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const store = await parseStep(source);
  seedModel('arch', 0, store, 52);
  assert.equal(extractAllMaterialsOnDemand(store, 52)[0]?.name, 'concrete_reinforced_in-situ', 'real SketchUp slab52 is associated to material62');
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setExpressIdWatermark(100_000); // Fixture model allocation watermark, matching native StoreEditor.
  const list = view.createEntity('IfcMaterialList', [['#62']]);
  view.setAttribute(61, 'RelatingMaterial', `#${list.expressId}`);
  view.setAttribute(62, 'Name', '$');
  const live = extractAllMaterialsOnDemand(store, 52, view)[0];
  assert.equal(live.type, 'MaterialList');
  assert.deepEqual(live.materials, [{ name: 'Material #62' }]);
  const liveUnresolved = live.unresolved;
  const exported = await exportAndReparse('arch', store);
  assert.equal(exported.getEntity(62)?.attributes?.[0], null, 'actual native STEP reparse proves the stored null Name');
  assert.deepEqual(exported.getEntity(list.expressId)?.attributes?.[0], [62], 'native STEP reparse preserves list membership');
  assert.notEqual(liveUnresolved, true, 'the native public null write is known, not unreadable');
  const reparsed = extractAllMaterialsOnDemand(exported, 52)[0];
  assert.deepEqual(reparsed, live);
  const accessor = createDataAccessor(exported);
  assert.deepEqual(accessor.getMaterials(52), [{ name: 'Material #62', category: undefined }]);
  assert.equal(checkMaterialFacet({ type: 'material' }, 52, accessor).passed, true);
  assert.equal(checkMaterialFacet({ type: 'material', value: { type: 'simpleValue', value: 'Unrelated' } }, 52, accessor).failure?.type, 'MATERIAL_VALUE_MISMATCH');
});
