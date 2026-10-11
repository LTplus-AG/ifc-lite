/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { editHostedElementInStore, readHostedFill, readHostedElementSize } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const state = useViewerStore.getState;
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : ''); return value.expressId;
};

for (const units of ['m', 'mm'] as const) for (const kind of ['door', 'window', 'opening'] as const)
for (const fields of kind === 'opening' ? ['Offset', 'Sill', 'all'] : ['Offset', 'Sill', 'OverallWidth', 'OverallHeight', 'all'])
test(`#7265 reviewed ${units} ${kind} ${fields} admits the native hosted occurrence edit and preserves its binding through export/Undo`, async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const host = created(state().addWall(SAMPLE_MODEL, storey, { Start: [20, 20, 0], End: [32, 20, 0], Thickness: .25, Height: 4, Name: 'Public native hosted edit host' }));
  const id = created(state().addHostedFill(SAMPLE_MODEL, host, kind === 'opening'
    ? { kind, params: { Offset: 2, Sill: .7, Width: 1, Height: 1.2, Name: 'Public native bare opening' } }
    : { kind, params: { Offset: 2, Sill: .7, Width: 1, Height: 1.2, Name: `Public native ${kind}` } }));
  const target = modelEditTarget(state(), SAMPLE_MODEL)!;
  target.view.setProperty(id, 'HostedEditAudit', 'Witness', 'effective metadata must stay attached');
  const source = await parseIfc(editedModelBytes(dataStore, target.view));
  const nativeView = new MutablePropertyView(source.properties, SAMPLE_MODEL), nativeEditor = new StoreEditor(source, nativeView);
  const before = readHostedFill(source, id, nativeView); assert.ok(before);
  assert.equal(before.hostId, host); assert.equal(before.offset, 2); assert.equal(before.sill, .7);
  const size = readHostedElementSize(source, id, nativeView);
  if (kind === 'opening') assert.equal(size, null); else assert.deepEqual(size, { OverallWidth: 1, OverallHeight: 1.2 });
  const full = kind === 'opening' ? { Offset: 5, Sill: .5 } : { Offset: 5, Sill: .5, OverallWidth: 1.3, OverallHeight: 1.6 };
  const edit: { Offset?: number; Sill?: number; OverallWidth?: number; OverallHeight?: number } = fields === 'all' ? full : Object.fromEntries(Object.entries(full).filter(([key]) => key === fields));
  const native = editHostedElementInStore(source, nativeEditor, id, edit);
  assert.equal(native.offset, edit.Offset ?? 2); assert.equal(native.sill, edit.Sill ?? .7);
  const savedNative = editedModelBytes(source, nativeView);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(savedNative)), []);
  const exportedNative = await parseIfc(savedNative);
  const after = readHostedFill(exportedNative, id); assert.ok(after);
  assert.equal(after.hostId, host); assert.equal(after.openingId, before.openingId); assert.equal(after.fillingId, before.fillingId);
  assert.equal(after.offset, edit.Offset ?? 2); assert.equal(after.sill, edit.Sill ?? .7);
  const factor = units === 'mm' ? 1000 : 1, scale = getModelLengthUnitScale(source);
  const expected = { ...before, offset: before.offset * factor, sill: before.sill * factor,
    location: before.location.map(value => value * scale * factor),
    size: size && { OverallWidth: size.OverallWidth * factor, OverallHeight: size.OverallHeight * factor } };
  const operation = { op: 'hosted.edit', target: { modelId: SAMPLE_MODEL, globalId: source.entities.getGlobalId(id), ifcClass: source.entities.getTypeName(id), name: source.entities.getName(id) },
    expected, edit: Object.fromEntries(Object.entries(edit).map(([field, value]) => [field, value * factor])) };
  const input = JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native hosted occurrence edit', units, frame: 'storey-local', operations: [operation] });
  // #7265: public native writer + independent export preconditions must pass
  // before the omitted reviewed contract is asserted; no mock provides them.
  assert.doesNotThrow(() => parseModelAuthoringBatch(input), 'review must admit the existing native hosted edit field family');
  const proposal = parseModelAuthoringBatch(input), count = target.view.getMutationCount();
  const preview = previewModelAuthoring(state(), proposal);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native hosted row status'); assert.equal(target.view.getMutationCount(), count);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native hosted edit test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const reviewed = await parseIfc(editedModelBytes(dataStore, state().mutationViews.get(SAMPLE_MODEL)!));
  const reviewedRead = readHostedFill(reviewed, id); assert.ok(reviewedRead);
  const { locationPointId: reviewedPoint, ...reviewedBinding } = reviewedRead;
  const { locationPointId: nativePoint, ...nativeBinding } = after;
  if (edit.Offset !== undefined || edit.Sill !== undefined) {
    assert.notEqual(reviewedPoint, before.locationPointId, 'native movement makes a fresh occurrence placement helper');
    assert.notEqual(nativePoint, before.locationPointId);
  } else {
    assert.equal(reviewedPoint, before.locationPointId, 'size-only native edits retain the placement helper');
    assert.equal(nativePoint, before.locationPointId);
  }
  assert.deepEqual(reviewedBinding, nativeBinding, 'reviewed native binding and position match the independent native writer');
  assert.deepEqual(readHostedElementSize(reviewed, id), readHostedElementSize(exportedNative, id), 'native overall dimensions match');
  assert.equal(reviewed.entities.getGlobalId(id), source.entities.getGlobalId(id));
  const metadata = (store: typeof source) => extractPropertiesOnDemand(store, id).map(({ name, properties }) => ({ name, properties }));
  assert.deepEqual(metadata(reviewed), metadata(source), 'effective occurrence metadata values remain attached; virtual export GUID allocation is independent');
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(dataStore, state().mutationViews.get(SAMPLE_MODEL)!));
  assert.deepEqual(readHostedFill(undone, id), before); assert.deepEqual(readHostedElementSize(undone, id), size);
});

// Native file units are a separate contract from the proposal's declared units.
for (const fileUnit of ['metre', 'millimetre'] as const)
test(`#7265 native ${fileUnit} source receives the same mm hosted edit and restores its frame`, async () => {
  const view = await seedModelingSession({ unit: fileUnit, storeyOffset: [3, 7] });
  const dataStore = state().models.get(MODEL_ID)!.ifcDataStore!;
  const host = created(state().addWall(MODEL_ID, STOREY, { Start: [20, 20, 0], End: [32, 20, 0], Thickness: .25, Height: 4 }));
  const id = created(state().addHostedFill(MODEL_ID, host, { kind: 'window', params: { Offset: 2, Sill: .7, Width: 1, Height: 1.2 } }));
  const source = await parseIfc(editedModelBytes(dataStore, view)), binding = readHostedFill(source, id); assert.ok(binding);
  const scale = getModelLengthUnitScale(source); assert.equal(scale, fileUnit === 'metre' ? 1 : .001);
  const size = readHostedElementSize(source, id); assert.ok(size);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native source units', units: 'mm', frame: 'storey-local', operations: [{
    op: 'hosted.edit', target: { modelId: MODEL_ID, globalId: source.entities.getGlobalId(id), ifcClass: 'IfcWindow', name: source.entities.getName(id) },
    expected: { ...binding, offset: binding.offset * 1000, sill: binding.sill * 1000, location: binding.location.map(value => value * scale * 1000),
      size: { OverallWidth: size.OverallWidth * 1000, OverallHeight: size.OverallHeight * 1000 } }, edit: { Offset: 5000, Sill: 500, OverallWidth: 1300, OverallHeight: 1600 } }] }));
  const preview = previewModelAuthoring(state(), batch); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native unit row');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native source units'); assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(readHostedFill(after, id)?.offset, 5); assert.equal(readHostedFill(after, id)?.sill, .5);
  assert.deepEqual(readHostedElementSize(after, id), { OverallWidth: 1.3, OverallHeight: 1.6 });
  assert.deepEqual(undoModelChanges(useViewerStore, result.receipt), { ok: true });
  assert.deepEqual(readHostedFill(await parseIfc(editedModelBytes(dataStore, view)), id), binding);
});
