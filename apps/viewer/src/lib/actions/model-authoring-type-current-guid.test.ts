/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { readRelatedLists } from '@ifc-lite/create';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { nativeTypeEvidence } from './native-type-evidence';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { seedAuthoringSample, parseIfc, BACK_WALL, SAMPLE_MODEL } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
for (const source of ['saved', 'authored'] as const) for (const mode of ['named', 'positional', 'both'] as const)
  test(`#7267 current ${source} native Type evidence matches ${mode} GlobalId edits in independent STEP`, async () => {
    const { dataStore, view } = await seedAuthoringSample();
    const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
    const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(id));
    assert.ok(relation); const original = relation.relatingId; assert.ok(typeof original === 'number');
    const editor = new StoreEditor(dataStore, view), record = dataStore.getEntity(original); assert.ok(record);
    const typeId = source === 'saved' ? original : editor.addEntity(record.type, [generateIfcGuid(), ...record.attributes.slice(1)]).expressId;
    if (source === 'authored') recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [id]));
    const guid = generateIfcGuid();
    if (mode === 'named') editor.setAttribute(typeId, 'GlobalId', guid);
    else {
      if (mode === 'both') editor.setAttribute(typeId, 'GlobalId', generateIfcGuid());
      editor.setPositionalAttribute(typeId, 0, guid);
    }
    const exported = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(exported.getEntity(typeId)?.attributes[0], guid, 'public writer establishes the exact current native identity and positional precedence');
    assert.ok(readRelatedLists(exported, 'IfcRelDefinesByType').some(row => row.relatingId === typeId && row.relatedIds.includes(id)));
    const state = useViewerStore.getState(), target = readOnlyModelEditTarget(state, SAMPLE_MODEL); assert.ok(target);
    const lease = view.prepareAtomic(() => null);
    const evidence = nativeTypeEvidence(state, target, id);
    assert.equal(evidence.status, 'typed');
    assert.equal(evidence.expected?.GlobalId, guid, 'the reviewed expected Type identity must match independent native STEP');
    assert.doesNotThrow(() => lease.validate(), 'canonical metadata evidence preserves the live native transaction lease');
  });
