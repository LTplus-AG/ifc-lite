/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { applyMaterialLayers, createElementType, setElementDimensions, setElementProfileSection, setElementType } from '@/components/viewer/model-inspector/inspector-edits';
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const s = useViewerStore.getState;
const created = (outcome: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in outcome, 'error' in outcome ? outcome.error : '');
  return outcome.expressId;
};
const batch = (operation: unknown) => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native shape edit', units: 'm', frame: 'storey-local', operations: [operation] }));

/** An independently reparsed native export, with no old overlay or singleton registration. */
async function exportedState(): Promise<ViewerState> {
  const state = s(), model = state.models.get(SAMPLE_MODEL)!;
  const bytes = editedModelBytes(model.ifcDataStore!, state.mutationViews.get(SAMPLE_MODEL) ?? null);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const store = await parseIfc(bytes);
  return { ...state, models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: store }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(store.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
}

test('#7229 reviewed wall dimensions admit the native occurrence-layer resize proven by IFC export', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const wall = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3, Name: 'Edited wall' }));
  const sibling = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 4, 0], End: [4, 4, 0], Thickness: .2, Height: 3, Name: 'Untouched sibling' }));
  const type = createElementType(SAMPLE_MODEL, 'wall', 'Shared native layers', wall);
  assert.ok(type !== null);
  assert.equal(setElementType(SAMPLE_MODEL, sibling, type), true);
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: wall, typeId: type,
    layers: [{ thickness: .1, material: { name: 'Brick' } }, { thickness: .1, material: { name: 'Plaster' } }] }) !== null);
  const before = await exportedState();
  const beforeStore = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const identity = beforeStore.entities.getGlobalId(wall);
  assert.equal(layerSetOf({ dataStore: beforeStore }, wall)?.via, 'type');
  assert.equal(setElementDimensions(SAMPLE_MODEL, wall, { kind: 'wall', height: 4, thickness: .45 }), true);
  const after = await exportedState();
  const afterStore = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.equal(afterStore.entities.getExpressIdByGlobalId(identity), wall);
  const wallSize = readWallMetres(modelEditTarget(after, SAMPLE_MODEL)!, wall);
  assert.equal(wallSize?.height, 4);
  assert.equal(wallSize?.thickness, .45);
  const layers = layerSetOf({ dataStore: afterStore }, wall);
  assert.equal(layers?.via, 'element');
  assert.deepEqual(layers?.layers.map((layer) => layer.thickness), [.1, .35]);
  assert.deepEqual(layerSetOf({ dataStore: afterStore }, sibling)?.layers.map((layer) => layer.thickness), [.1, .1], 'the shared type and sibling retain their native layers');
  assert.doesNotThrow(() => batch({ op: 'element.resize', target: { globalId: identity, ifcClass: 'IfcWall', name: 'Edited wall' },
    expected: { kind: 'wall', height: 4, thickness: .45 }, size: { kind: 'wall', height: 4.5, thickness: .5 } }),
  'review must admit the existing native dimension/layer edit');
});

test('#7229 reviewed profile replacement admits the native exported hollow-section edit', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const beam = created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 4], Width: .2, Height: .3, Name: 'Native section edit' }));
  const profile = { Type: 'CircleHollow' as const, Radius: .15, WallThickness: .01 };
  assert.equal(setElementProfileSection(SAMPLE_MODEL, beam, profile), true);
  const after = await exportedState();
  const store = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.deepEqual(readElementProfile(after, SAMPLE_MODEL, beam), profile, 'independent native STEP readback preserves actual section and millimetre-model conversion');
  assert.doesNotThrow(() => batch({ op: 'element.profile', target: { globalId: store.entities.getGlobalId(beam), ifcClass: 'IfcBeam', name: 'Native section edit' },
    expected: profile, Profile: { Type: 'Circle', Radius: .2 } }), 'review must admit the existing native section edit');
});
