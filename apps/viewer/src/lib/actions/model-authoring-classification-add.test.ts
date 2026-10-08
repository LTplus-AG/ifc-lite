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
import { BACK_WALL, BACK_WALL_NAME, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
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
  assert.deepEqual(editedModelBytes(dataStore, view), before);
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
    assert.deepEqual(editedModelBytes(dataStore, view), before);
  }
  const preview = previewModelAuthoring(useViewerStore.getState(), valid);
  assert.equal(preview.rows[0].status, 'ready');
  useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!.setPositionalAttribute(target, 4, 'Changed without history');
  const changed = editedModelBytes(dataStore, view);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
  assert.deepEqual(editedModelBytes(dataStore, view), changed);
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
  assert.deepEqual(editedModelBytes(dataStore, other), otherBytes);
});
