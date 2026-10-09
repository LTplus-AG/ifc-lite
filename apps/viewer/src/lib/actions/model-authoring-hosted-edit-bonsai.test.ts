/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { editHostedElementInStore, readHostedFill, readHostedElementSize, placedBodyExtent } from '@ifc-lite/create';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { undoModelChanges } from './model-change-commit';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
for (const fields of ['size', 'movement', 'all'] as const)
test(`#7265 actual Bonsai imported mapped window ${fields} keeps source type, sibling, metadata and native representations`, async () => {
  await seedAuthoringSample(); // Canonical store/edit/remesh setup; source replaced with real Bonsai fixture.
  const source = await parseIfc(readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
  const view = new MutablePropertyView(source.properties, SAMPLE_MODEL), state = useViewerStore.getState();
  const model = state.models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]), ifcDataStore: source,
    mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  const id = 1262, sibling = 1407, binding = readHostedFill(source, id); assert.ok(binding);
  assert.equal(source.entities.getTypeName(id), 'IfcWindow');
  const size = readHostedElementSize(source, id); assert.ok(size);
  const siblingBounds = placedBodyExtent(source, sibling); assert.ok(siblingBounds);
  const sharedIds = [436, 458, 459, 435, 427, 434, 410];
  const shared = sharedIds.map(entityId => source.getEntity(entityId)); assert.ok(shared.every(Boolean), 'actual mapped type/body/plan/style source records are present');
  const edit = { ...(fields !== 'size' ? { Offset: binding.offset + .2, Sill: binding.sill + .1 } : {}),
    ...(fields !== 'movement' ? { OverallWidth: 1.2, OverallHeight: 1.4 } : {}) };
  const nativeView = new MutablePropertyView(source.properties, SAMPLE_MODEL);
  editHostedElementInStore(source, new StoreEditor(source, nativeView), id, edit);
  const control = await parseIfc(editedModelBytes(source, nativeView));
  assert.deepEqual(sharedIds.map(entityId => control.getEntity(entityId)), shared, 'independent native writer preserves shared source data');
  const scale = getModelLengthUnitScale(source), batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Imported Bonsai hosted edit', units: 'm', frame: 'storey-local', operations: [{
    op: 'hosted.edit', target: { modelId: SAMPLE_MODEL, globalId: source.entities.getGlobalId(id), ifcClass: 'IfcWindow', name: source.entities.getName(id) },
    expected: { ...binding, location: binding.location.map(value => value * scale), size }, edit }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'Bonsai native edit');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'Bonsai source edit'); assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(source, view));
  const semanticBinding = (store: typeof source) => { const read = readHostedFill(store, id); assert.ok(read); const { locationPointId: _allocatedPoint, ...semantic } = read; return semantic; };
  assert.deepEqual(semanticBinding(after), semanticBinding(control));
  assert.deepEqual(readHostedElementSize(after, id), readHostedElementSize(control, id));
  assert.deepEqual(placedBodyExtent(after, sibling), siblingBounds);
  assert.deepEqual(sharedIds.map(entityId => after.getEntity(entityId)), shared);
  assert.deepEqual(extractPropertiesOnDemand(after, id), extractPropertiesOnDemand(source, id), 'saved source metadata is unchanged');
  assert.deepEqual(undoModelChanges(useViewerStore, result.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(source, view));
  assert.deepEqual(readHostedFill(undone, id), binding); assert.deepEqual(readHostedElementSize(undone, id), size);
});

test('#7265 actual Bonsai window with absent optional filling geometry still moves but cannot be sized', async () => {
  await seedAuthoringSample();
  const source = await parseIfc(readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url))), state = useViewerStore.getState();
  const view = new MutablePropertyView(source.properties, SAMPLE_MODEL), model = state.models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]), ifcDataStore: source,
    mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  modelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!.editor.setPositionalAttribute(1262, 6, null);
  const saved = await parseIfc(editedModelBytes(source, view)), binding = readHostedFill(saved, 1262); assert.ok(binding);
  assert.equal(saved.getEntity(1262)?.attributes[6], null); assert.equal(readHostedElementSize(saved, 1262), null);
  const nativeView = new MutablePropertyView(saved.properties, SAMPLE_MODEL), nativeEditor = new StoreEditor(saved, nativeView);
  const edit = { Offset: binding.offset + .2, Sill: binding.sill + .1 };
  editHostedElementInStore(saved, nativeEditor, 1262, edit);
  assert.throws(() => editHostedElementInStore(saved, nativeEditor, 1262, { OverallWidth: 1.2 }), /cannot be read/);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native missing optional representation', units: 'm', frame: 'storey-local', operations: [{
    op: 'hosted.edit', target: { modelId: SAMPLE_MODEL, globalId: saved.entities.getGlobalId(1262), ifcClass: 'IfcWindow', name: saved.entities.getName(1262) },
    expected: { ...binding, location: binding.location.map(value => value * getModelLengthUnitScale(saved)), size: null }, edit }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'movement with omitted filling representation');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native incomplete filling move'); assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(source, view));
  assert.equal(readHostedFill(after, 1262)?.offset, edit.Offset); assert.equal(readHostedFill(after, 1262)?.sill, edit.Sill);
  assert.equal(after.getEntity(1262)?.attributes[6], null); assert.equal(readHostedElementSize(after, 1262), null);
  assert.deepEqual(undoModelChanges(useViewerStore, result.receipt), { ok: true });
  assert.deepEqual(readHostedFill(await parseIfc(editedModelBytes(source, view)), 1262), binding);
});
