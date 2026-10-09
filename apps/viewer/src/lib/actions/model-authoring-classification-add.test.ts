/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractClassificationsOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { addClassificationAssociation } from '@/lib/authoring/associations';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { BACK_WALL, BACK_WALL_NAME, GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch, type ModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original, true));

async function nativeControl() {
  const { dataStore } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  assert.ok(target);
  assert.deepEqual(extractClassificationsOnDemand(dataStore, target), []);
  assert.deepEqual(addClassificationAssociation(SAMPLE_MODEL, target, {
    system: 'Explicit reviewed classification', identification: 'WALL-001', name: 'Native authored classification',
  }), { ok: true });
  const view = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!;
  const reparsed = await parseIfc(editedModelBytes(dataStore, view));
  const rows = extractClassificationsOnDemand(reparsed, target);
  assert.deepEqual(rows.map(row => [row.system, row.identification, row.name]),
    [['Explicit reviewed classification', 'WALL-001', 'Native authored classification']],
    'independent STEP reparse proves the existing native Properties writer creates a real classification association');
  assert.equal(reparsed.entities.getGlobalId(target), BACK_WALL);
  return { dataStore, target, view };
}

function reviewedAdd(): ModelAuthoringBatch {
  let parsed: ModelAuthoringBatch | undefined;
  assert.doesNotThrow(() => { parsed = parseModelAuthoringBatch(JSON.stringify({
    version: 1, kind: 'model.authoring', title: 'Add explicit reviewed classification', units: 'm', frame: 'storey-local',
    operations: [{ op: 'classification.add', target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: BACK_WALL_NAME },
      Classification: { Name: 'Explicit reviewed classification' },
      Reference: { Identification: 'WALL-002', Name: 'Additional approved classification' } }],
  })); }, '#7271 the existing native Add Classification action must also be admitted through explicit reviewed proposals');
  assert.ok(parsed);
  return parsed;
}

test('#7271 existing native Add produces independently readable IFC classifications without changing target identity', async () => {
  await nativeControl();
});

test('#7271 reviewed additive classification contract accepts the same explicit native metadata', async () => {
  await nativeControl();
  const parsed = reviewedAdd();
  assert.equal(parsed.operations[0].op, 'classification.add');
});

test('#7271 native system reuse follows an effective named classification Name edit', async () => {
  const { dataStore, target, view } = await nativeControl();
  const system = Array.from(view.getNewEntitiesOfType('IFCCLASSIFICATION'))[0];
  assert.ok(system);
  view.setAttribute(system.expressId, 'Name', 'Renamed current classification');
  const first = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(extractClassificationsOnDemand(first, target)[0].system, 'Renamed current classification');
  assert.deepEqual(addClassificationAssociation(SAMPLE_MODEL, target, { system: 'Renamed current classification', identification: 'WALL-003' }), { ok: true });
  assert.equal(Array.from(view.getNewEntitiesOfType('IFCCLASSIFICATION')).length, 1, 'native Add reuses the exact current named system rather than creating a duplicate');
});

test('#7271 reviewed classification preserves existing metadata through native export and grouped Undo/Redo', async () => {
  const { dataStore, target, view } = await nativeControl();
  const state = useViewerStore.getState();
  const before = editedModelBytes(dataStore, view);
  const lease = view.prepareAtomic(() => null);
  const preview = previewModelAuthoring(state, reviewedAdd());
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  assert.equal(useViewerStore.getState().undoStacks, state.undoStacks);
  assert.equal(useViewerStore.getState().dirtyModels, state.dirtyModels);
  assert.doesNotThrow(() => lease.validate(), 'preview must leave the native allocator watermark unchanged');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(outcome.receipt.batches.length, 1);
  assert.equal(outcome.receipt.applied[0].field, 'Classification');
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(exported.entities.getGlobalId(target), BACK_WALL);
  assert.equal(exported.entities.getName(target), BACK_WALL_NAME);
  assert.deepEqual(extractClassificationsOnDemand(exported, target).map(row => row.identification).sort(), ['WALL-001', 'WALL-002']);
  assert.equal(Array.from(view.getNewEntitiesOfType('IFCCLASSIFICATION')).length, 1);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(extractClassificationsOnDemand(undone, target).map(row => row.identification), ['WALL-001']);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  const redone = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(extractClassificationsOnDemand(redone, target).map(row => row.identification).sort(), ['WALL-001', 'WALL-002']);
});

test('#7271 classification metadata preflight refuses stale identity, wrong schema spelling and STEP tokens without publishing', async () => {
  const { dataStore, view, target } = await nativeControl();
  const valid = reviewedAdd();
  const before = editedModelBytes(dataStore, view);
  for (const operation of [
    { ...valid.operations[0], target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: 'Different current Name' } },
    { ...valid.operations[0], Reference: { ItemReference: 'IFC2X3-only' } },
    { ...valid.operations[0], Reference: { Identification: '#291' } },
  ]) {
    const batch = parseModelAuthoringBatch(JSON.stringify({ ...valid, operations: [operation] }));
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    assert.notEqual(preview.rows[0].status, 'ready');
    assert.equal(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok, false);
    await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  }
  const preview = previewModelAuthoring(useViewerStore.getState(), valid);
  assert.equal(preview.rows[0].status, 'ready');
  useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setPositionalAttribute(target, 4, 'Changed without history');
  const changed = editedModelBytes(dataStore, view);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), changed);
});

test('#7271 classification contract rejects unknown fields, contradictory code spellings and unbounded text', () => {
  const batch = reviewedAdd();
  const base = batch.operations[0];
  for (const operation of [
    { ...base, expected: null },
    { ...base, Classification: { Name: 'Named', Edition: 'unreviewed' } },
    { ...base, Reference: { Identification: 'A', ItemReference: 'B' } },
    { ...base, Reference: { Identification: 'A', Location: 'unreviewed' } },
    { ...base, Reference: { Identification: 'x'.repeat(201) } },
  ]) assert.throws(() => parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: [operation] })));
});

test('#7271 federated classification addition requires an explicit owner and preserves the other native model', async () => {
  const { dataStore, target, view } = await nativeControl();
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.getState().addModel({ ...model, id: 'other', name: 'Other actual IFC owner', idOffset: 2_000_000 });
  const other = new MutablePropertyView(dataStore.properties ?? null, 'other');
  useViewerStore.getState().registerMutationView('other', other);
  const batch = reviewedAdd();
  const ambiguous = parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: batch.operations.map(op => ({ ...op,
    target: { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME } })) }));
  assert.equal(previewModelAuthoring(useViewerStore.getState(), ambiguous).rows[0].status, 'ambiguous-target');
  const otherBytes = editedModelBytes(dataStore, other);
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(outcome.receipt.applied[0].modelId, SAMPLE_MODEL);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(extractClassificationsOnDemand(exported, target).map(row => row.identification).sort(), ['WALL-001', 'WALL-002']);
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, other), otherBytes);
});

test('#7271 reviewed Add reuses an independently exported source system with its current Name', async () => {
  const { dataStore, target, view } = await nativeControl();
  const reparsed = await parseIfc(editedModelBytes(dataStore, view));
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const sourceView = new MutablePropertyView(reparsed.properties ?? null, SAMPLE_MODEL);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: reparsed }]]),
    mutationViews: new Map([[SAMPLE_MODEL, sourceView]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  const preview = previewModelAuthoring(useViewerStore.getState(), reviewedAdd());
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(Array.from(sourceView.getNewEntitiesOfType('IFCCLASSIFICATION')).length, 0, 'the source system is reused');
  const exported = await parseIfc(editedModelBytes(reparsed, sourceView));
  assert.deepEqual(extractClassificationsOnDemand(exported, target).map(row => row.identification).sort(), ['WALL-001', 'WALL-002']);
});

for (const ownerHistory of [true, false]) {
  test(`#7271 IFC2X3 classification layouts ${ownerHistory ? 'retain native OwnerHistory' : 'refuse missing mandatory OwnerHistory'}`, async () => {
    await seedAuthoringSample();
    // Stated schema invariant, not an authoring-tool fixture: IFC2X3 RelatedObjects requires IfcRoot and the relationship requires OwnerHistory.
    const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('invariant.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n${ownerHistory ? '#5=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);\n' : ''}#1=IFCPROJECT('0Project0000000000000a',${ownerHistory ? '#5' : '$'},'P',$,$,$,$,$,$);\n#10=IFCWALL('0Wall00000000000000010',${ownerHistory ? '#5' : '$'},'Wall A',$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;`;
    const source = await parseIfc(new TextEncoder().encode(text));
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    const view = new MutablePropertyView(source.properties ?? null, SAMPLE_MODEL);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]),
      mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
    const batch = parseModelAuthoringBatch(JSON.stringify({ ...reviewedAdd(), operations: [{ op: 'classification.add',
      target: { globalId: '0Wall00000000000000010', modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: 'Wall A' },
      Classification: { Name: 'Explicit legacy system' }, Reference: { ItemReference: 'LEGACY-001' } }] }));
    const before = editedModelBytes(source, view);
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    if (!ownerHistory) {
      assert.notEqual(preview.rows[0].status, 'ready');
      assert.equal(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok, false);
      await assertSameNativeIfcGraph(editedModelBytes(source, view), before);
      return;
    }
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
    const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
    assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
    const exported = await parseIfc(editedModelBytes(source, view));
    assert.deepEqual(extractClassificationsOnDemand(exported, 10).map(row => [row.system, row.identification]), [['Explicit legacy system', 'LEGACY-001']]);
    const relation = Array.from(view.getNewEntitiesOfType('IFCRELASSOCIATESCLASSIFICATION'))[0];
    assert.ok(relation);
    assert.equal(exported.getEntity(relation.expressId)?.attributes[1], 5);
  });
}

test('#7271 classification resolves a freshly authored native wall identity outside the source index', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const creation = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Fresh native wall',
    units: 'm', frame: 'storey-local', operations: [{ op: 'element.create', ref: 'new-wall', ifcClass: 'IfcWall',
      storey: { globalId: GROUND_STOREY }, name: 'Current authored wall',
      params: { start: [10, 10, 0], end: [14, 10, 0], thickness: .2, height: 3 } }] }));
  const created = commitModelAuthoring(useViewerStore, previewModelAuthoring(useViewerStore.getState(), creation), new Set([0]), 'test');
  assert.ok(created.ok, created.ok ? '' : created.detail ?? created.reason);
  const globalId = created.receipt.applied[0].globalId;
  assert.equal(dataStore.entities.getExpressIdByGlobalId(globalId), -1);
  const independent = await parseIfc(editedModelBytes(dataStore, view));
  const target = independent.entities.getExpressIdByGlobalId(globalId);
  assert.ok(target > 0);
  assert.equal(independent.entities.getName(target), 'Current authored wall');
  const add = parseModelAuthoringBatch(JSON.stringify({ ...reviewedAdd(), operations: [{ op: 'classification.add',
    target: { globalId, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: 'Current authored wall' },
    Classification: { Name: 'Explicit authored system' }, Reference: { Identification: 'NEW-001' } }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), add);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(exported.entities.getGlobalId(target), globalId);
  assert.deepEqual(extractClassificationsOnDemand(exported, target).map(row => row.identification), ['NEW-001']);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const undone = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(undone.entities.getGlobalId(target), globalId, 'Undo addition preserves the previously created native wall');
  assert.deepEqual(extractClassificationsOnDemand(undone, target), []);
});


test('#7271 reviewed Add reuses a source entity retyped into the current native classification system', async () => {
  const { dataStore, target, view } = await nativeControl();
  const materialId = dataStore.entityIndex.byType.get('IFCMATERIAL')?.[0];
  assert.ok(materialId, 'real authoring fixture contains a source material');
  const name = 'Retyped current classification system';
  view.setEntityType(materialId, 'IfcClassification');
  view.setAttribute(materialId, 'Name', name);
  const before = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(before.entities.getTypeName(materialId), 'IfcClassification');
  assert.equal(before.getEntity(materialId)?.attributes[3], name, 'native exporter independently confirms the retyped system Name');
  const batch = reviewedAdd();
  assert.equal(batch.operations[0].op, 'classification.add');
  if (batch.operations[0].op !== 'classification.add') throw new Error('Expected classification operation');
  batch.operations[0].Classification.Name = name;
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const after = await parseIfc(editedModelBytes(dataStore, view));
  const systems = [...(after.entityIndex.byType.get('IFCCLASSIFICATION') ?? [])]
    .filter(id => after.getEntity(id)?.attributes[3] === name);
  assert.deepEqual(systems, [materialId], 'native reviewed Add must reuse the current source system rather than create a duplicate');
  assert.ok(extractClassificationsOnDemand(after, target).some(row => row.system === name && row.identification === 'WALL-002'));
});
