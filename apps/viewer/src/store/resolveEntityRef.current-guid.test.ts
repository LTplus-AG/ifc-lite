/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
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
test('#7282 forward identity never publishes a native non-Root Name or deleted Root GlobalId', async () => {
  const { dataStore, view } = await seedAuthoringSample(), editor = new StoreEditor(dataStore, view);
  const material = editor.addEntity('IfcMaterial', ['Material has no GlobalId', null, null]);
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL); assert.equal(editor.removeEntity(id), true);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.getEntity(id), null); assert.equal(saved.getEntity(material.expressId)?.attributes[0], 'Material has no GlobalId');
  const state = useViewerStore.getState();
  assert.equal(resolveEntityRefGlobalIdFromState(state, { modelId: SAMPLE_MODEL, expressId: material.expressId }), null);
  assert.equal(resolveEntityRefGlobalIdFromState(state, { modelId: SAMPLE_MODEL, expressId: id }), null);
});
