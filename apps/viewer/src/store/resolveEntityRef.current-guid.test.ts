/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { useViewerStore } from './index';
import { resolveEntityRefGlobalIdFromState } from './resolveEntityRef';
import { BACK_WALL, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
for (const edit of ['named', 'positional', 'both'] as const) for (const federation of [false, true])
test(`#7282 forward identity ${edit} ${federation ? 'N' : '1'} matches native saved Root and preserves read lease`, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL), current = generateIfcGuid();
  if (federation) {
    const peer = await parseIfc(dataStore.source.materialize()), model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['peer', { ...model, id: 'peer', ifcDataStore: peer }]]),
      mutationViews: new Map([[SAMPLE_MODEL, view], ['peer', new MutablePropertyView(peer.properties, 'peer')]]) });
    assert.equal(peer.entities.getGlobalId(id), BACK_WALL);
  }
  const editor = new StoreEditor(dataStore, view);
  if (edit !== 'positional') editor.setAttribute(id, 'GlobalId', edit === 'both' ? generateIfcGuid() : current);
  if (edit !== 'named') editor.setPositionalAttribute(id, 0, current);
  editor.setEntityType(id, 'IfcWallStandardCase');
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.entities.getGlobalId(id), current); assert.equal(saved.entities.getTypeName(id), 'IfcWallStandardCase');
  const lease = view.prepareAtomic(draft => draft.getMutations()), held = useViewerStore.getState(), journal = view.getMutations();
  assert.equal(resolveEntityRefGlobalIdFromState(held, { modelId: SAMPLE_MODEL, expressId: id }), current);
  if (federation) assert.equal(resolveEntityRefGlobalIdFromState(held, { modelId: 'peer', expressId: id }), BACK_WALL);
  assert.equal(useViewerStore.getState(), held); assert.deepEqual(view.getMutations(), journal); assert.doesNotThrow(lease.validate);
});
test('#7282 forward identity never publishes a native non-Root Name', async () => {
  const { dataStore, view } = await seedAuthoringSample(), editor = new StoreEditor(dataStore, view);
  const material = editor.addEntity('IfcMaterial', ['Material has no GlobalId', null, null]);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.getEntity(material.expressId)?.attributes[0], 'Material has no GlobalId');
  assert.equal(resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: SAMPLE_MODEL, expressId: material.expressId }), null);
});
test('#7282 forward identity refuses a native deleted Root despite its retained parsed GUID column', async () => {
  const { dataStore, view } = await seedAuthoringSample(), editor = new StoreEditor(dataStore, view);
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL); assert.equal(editor.removeEntity(id), true);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.getEntity(id), null); assert.equal(dataStore.entities.getGlobalId(id), BACK_WALL);
  assert.equal(resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: SAMPLE_MODEL, expressId: id }), null);
});

for (const nameEdited of [false, true]) test(`#7282 forward identity preserves a cached source-free ${nameEdited ? 'Name-edited' : 'unedited'} Root identity`, async () => {
  const { dataStore, view } = await seedAuthoringSample(), id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  if (nameEdited) {
    new StoreEditor(dataStore, view).setAttribute(id, 'Name', 'Cached source-free Name');
    const saved = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(saved.entities.getName(id), 'Cached source-free Name'); assert.equal(saved.entities.getGlobalId(id), BACK_WALL);
  }
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const cached = { ...dataStore, source: EMPTY_SOURCE_BYTES };
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: cached }]]) });
  assert.equal(cached.entities.getGlobalId(id), BACK_WALL); assert.equal(cached.entities.getTypeName(id), 'IfcWall');
  assert.equal(resolveEntityRefGlobalIdFromState(useViewerStore.getState(), { modelId: SAMPLE_MODEL, expressId: id }), BACK_WALL);
});


for (const sourceFree of [false, true]) test(`#7282 immutable parsed ${sourceFree ? 'cached' : 'source'} columns retain only real Root identity without a mutation view`, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const material = new StoreEditor(dataStore, view).addEntity('IfcMaterial', ['Native non-Root material name', null, null]);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const rootId = saved.entities.getExpressIdByGlobalId(BACK_WALL);
  assert.equal(saved.getEntity(material.expressId)?.attributes[0], 'Native non-Root material name');
  assert.equal(saved.entities.getGlobalId(material.expressId), '');
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const current = sourceFree ? { ...saved, source: EMPTY_SOURCE_BYTES } : saved;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: current }]]), mutationViews: new Map() });
  const held = useViewerStore.getState();
  assert.equal(resolveEntityRefGlobalIdFromState(held, { modelId: SAMPLE_MODEL, expressId: rootId }), BACK_WALL);
  assert.equal(resolveEntityRefGlobalIdFromState(held, { modelId: SAMPLE_MODEL, expressId: material.expressId }), null);
  assert.equal(useViewerStore.getState(), held);
});
