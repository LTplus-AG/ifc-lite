/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { nativeTypeEvidence } from './native-type-evidence';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readRelatedLists } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { writeNativeTypeDetach } from './model-authoring-native';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readElementProfileFromTarget } from '@/store/slices/mutation-element-profile';
import { BACK_WALL, BACK_WALL_NAME, GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { parseModelAuthoringBatch } from './model-authoring';
import { commitModelAuthoring } from './model-authoring-commit';
import { previewModelAuthoring } from './model-authoring-preview';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));

function requiredTypeId(relation: { relatingId?: number }): number {
  const id = relation.relatingId;
  assert.ok(typeof id === 'number' && id > 0, 'native type relationship has an explicit positive relating EXPRESS ID');
  return id;
}
for (const kind of ['resize', 'profile'] as const) test(`#7267 first-read ${kind} preview preserves the native lease on an independently saved procedural source`, async () => {
  const { dataStore, view: live } = await seedAuthoringSample();
  const state = useViewerStore.getState(), storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const params = { Start: [20, 20, 0] as [number, number, number], End: [24, 20, 0] as [number, number, number], Name: 'Saved native pure preview' };
  const made = kind === 'resize' ? state.addWall(SAMPLE_MODEL, storey, { ...params, Thickness: .25, Height: 4 })
    : state.addBeam(SAMPLE_MODEL, storey, { ...params, Width: .2, Height: .3 });
  assert.ok('expressId' in made); const id = made.expressId;
  const source = await parseIfc(editedModelBytes(dataStore, live));
  const view = new MutablePropertyView(source.properties, SAMPLE_MODEL), model = state.models.get(SAMPLE_MODEL); assert.ok(model);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]), mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map() });
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL); assert.ok(reader);
  const expected = kind === 'resize' ? readAuthoringSizeFromTarget(reader, id, 'wall') : readElementProfileFromTarget(reader, id); assert.ok(expected);
  const lease = view.prepareAtomic(() => null), editors = useViewerStore.getState().storeEditors;
  const operation = { op: `element.${kind}`, target: { modelId: SAMPLE_MODEL, globalId: source.entities.getGlobalId(id), ifcClass: source.entities.getTypeName(id), name: source.entities.getName(id) }, expected,
    ...(kind === 'resize' ? { size: { kind: 'wall', height: 4.1, thickness: .25 } } : { Profile: { Type: 'Circle', Radius: .25 } }) };
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Pure native preview', units: 'm', frame: 'storey-local', operations: [operation] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
  assert.doesNotThrow(() => lease.validate(), 'read-only preflight and native ghost cannot invalidate the live allocator lease');
  assert.equal(useViewerStore.getState().storeEditors, editors); assert.equal(editors.size, 0);
});

for (const duplicate of ['target', 'type'] as const) test(`#7267 genuine same-model ${duplicate} root GUID collision refuses type detachment`, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(id)); assert.ok(relation);
  const copyId = duplicate === 'target' ? id : requiredTypeId(relation);
  const original = dataStore.getEntity(copyId); assert.ok(original);
  const copy = new StoreEditor(dataStore, view).addEntity(original.type, original.attributes);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  const GlobalId = dataStore.entities.getGlobalId(copyId);
  assert.equal(exported.getEntity(copyId)?.attributes[0], GlobalId); assert.equal(exported.getEntity(copy.expressId)?.attributes[0], GlobalId);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Ambiguous native root', units: 'm', frame: 'storey-local', operations: [{ op: 'type.detach', target: { modelId: SAMPLE_MODEL, globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME }, expected: { GlobalId: dataStore.entities.getGlobalId(requiredTypeId(relation)), Name: dataStore.entities.getName(requiredTypeId(relation)) } }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ambiguous-target', preview.rows[0].issue ?? 'native type review status');
});

test('#7267 earlier native type assignment cannot invalidate a later detach expectation silently', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const id = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(id)); assert.ok(relation);
  const replacement = dataStore.entities.getExpressIdByGlobalId('2YJwrhcCv9v8UXU8cWK40m');
  assert.ok(replacement > 0 && replacement !== requiredTypeId(relation));
  const target = { modelId: SAMPLE_MODEL, globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME };
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native intermediate type ownership', units: 'm', frame: 'storey-local', operations: [
    { op: 'type.assign', target, expected: dataStore.entities.getName(requiredTypeId(relation)), type: { globalId: dataStore.entities.getGlobalId(replacement), name: dataStore.entities.getName(replacement) } },
    { op: 'type.detach', target, expected: { GlobalId: dataStore.entities.getGlobalId(requiredTypeId(relation)), Name: dataStore.entities.getName(requiredTypeId(relation)) } },
  ] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
  assert.notEqual(preview.rows[1].status, 'ready', 'detach must recheck the expected current type on the actual intermediate native draft');
  const unchanged = await parseIfc(editedModelBytes(dataStore, view));
  assert.ok(readRelatedLists(unchanged, 'IfcRelDefinesByType').some(row => row.relatingId === requiredTypeId(relation) && row.relatedIds.includes(id)));
});


test('#7267 native intermediate detach accepts the matching replacement and refuses the old binding atomically', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const originalType = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(target)); assert.ok(originalType);
  const replacement = dataStore.entities.getExpressIdByGlobalId('2YJwrhcCv9v8UXU8cWK40m');
  assert.ok(replacement > 0 && replacement !== requiredTypeId(originalType));
  const operation = (typeId: number) => ({ op: 'type.detach' as const,
    target: { modelId: SAMPLE_MODEL, globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME },
    expected: { GlobalId: dataStore.entities.getGlobalId(typeId), Name: dataStore.entities.getName(typeId) ?? '' } });
  assert.throws(() => recordModellingEdit(useViewerStore, SAMPLE_MODEL, (methods, draft) => {
    methods.assignType(SAMPLE_MODEL, replacement, [target]);
    writeNativeTypeDetach(operation(requiredTypeId(originalType)), dataStore, draft, { target, typeId: requiredTypeId(originalType) });
  }), /expected binding/);
  const refused = await parseIfc(editedModelBytes(dataStore, view));
  assert.ok(readRelatedLists(refused, 'IfcRelDefinesByType').some(row => row.relatingId === requiredTypeId(originalType) && row.relatedIds.includes(target)), 'failed native group restores the original exported assignment');
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, (methods, draft) => {
    methods.assignType(SAMPLE_MODEL, replacement, [target]);
    writeNativeTypeDetach(operation(replacement), dataStore, draft, { target, typeId: replacement });
  });
  const detached = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(readRelatedLists(detached, 'IfcRelDefinesByType').some(row => row.relatedIds.includes(target)), false);
  assert.equal(detached.entities.getGlobalId(replacement), dataStore.entities.getGlobalId(replacement), 'the replacement type itself remains');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const restored = await parseIfc(editedModelBytes(dataStore, view));
  assert.ok(readRelatedLists(restored, 'IfcRelDefinesByType').some(row => row.relatingId === requiredTypeId(originalType) && row.relatedIds.includes(target)), 'one native Undo restores the pre-assignment binding');
});


for (const subject of ['target', 'type'] as const) for (const origin of ['live', 'saved', 'deleted'] as const)
  test(`#7267 ${origin} non-root material Name matching the ${subject} GUID does not deny a native detachment`, async () => {
    let { dataStore, view } = await seedAuthoringSample();
    const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
    const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(target)); assert.ok(relation);
    const typeId = requiredTypeId(relation);
    const editor = new StoreEditor(dataStore, view);
    const materialGuid = subject === 'target' ? BACK_WALL : dataStore.entities.getGlobalId(typeId);
    const material = editor.addEntity('IfcMaterial', [materialGuid]);
    if (origin !== 'live') {
      const parsed = await parseIfc(editedModelBytes(dataStore, view));
      assert.equal(parsed.getEntity(material.expressId)?.attributes[0], materialGuid);
      const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL); assert.ok(model);
      dataStore = parsed; view = new MutablePropertyView(parsed.properties, SAMPLE_MODEL);
      useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: parsed }]]), mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map() });
      if (origin === 'deleted') new StoreEditor(parsed, view).removeEntity(material.expressId);
    }
    const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native root role', units: 'm', frame: 'storey-local', operations: [{ op: 'type.detach', target: { modelId: SAMPLE_MODEL, globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME }, expected: { GlobalId: dataStore.entities.getGlobalId(typeId), Name: dataStore.entities.getName(typeId) ?? '' } }] }));
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
    const committed = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'Native root role');
    assert.ok(committed.ok, committed.ok ? '' : committed.detail ?? committed.reason);
    const detached = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(readRelatedLists(detached, 'IfcRelDefinesByType').some(row => row.relatedIds.includes(target)), false);
    assert.equal(detached.entities.getGlobalId(typeId), dataStore.entities.getGlobalId(typeId));
    useViewerStore.getState().undo(SAMPLE_MODEL);
    const restored = await parseIfc(editedModelBytes(dataStore, view));
    assert.ok(readRelatedLists(restored, 'IfcRelDefinesByType').some(row => row.relatingId === typeId && row.relatedIds.includes(target)));
  });


test('#7267 valid source-empty transport keeps imported binding unavailable and complete authored binding explicit', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const original = dataStore.getEntity(target); assert.ok(original);
  const association = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(row => row.relatedIds.includes(target)); assert.ok(association);
  const originalType = dataStore.getEntity(requiredTypeId(association)); assert.ok(originalType);
  const editor = new StoreEditor(dataStore, view);
  const occurrenceGlobalId = generateIfcGuid(), typeGlobalId = generateIfcGuid();
  const occurrence = editor.addEntity(original.type, [occurrenceGlobalId, ...original.attributes.slice(1)]);
  const type = editor.addEntity(originalType.type, [typeGlobalId, ...originalType.attributes.slice(1)]);
  editor.addEntity('IfcRelDefinesByType', [generateIfcGuid(), original.attributes[1], null, null, [`#${occurrence.expressId}`], `#${type.expressId}`]);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.ok(readRelatedLists(saved, 'IfcRelDefinesByType').some(row => row.relatedIds.includes(occurrence.expressId) && row.relatingId === type.expressId));
  const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL); assert.ok(model);
  const opaque = { ...dataStore, source: EMPTY_SOURCE_BYTES };
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: opaque }]]) });
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL); assert.ok(reader);
  assert.deepEqual(nativeTypeEvidence(useViewerStore.getState(), reader, target), { status: 'unavailable', expected: null }, 'retained source decoder is not evidence when valid source bytes are absent');
  assert.deepEqual(nativeTypeEvidence(useViewerStore.getState(), reader, occurrence.expressId), { status: 'typed', expected: { GlobalId: typeGlobalId, Name: originalType.attributes[2] } }, 'complete authored occurrence/type/association records remain available without guessing original source fields');
});
