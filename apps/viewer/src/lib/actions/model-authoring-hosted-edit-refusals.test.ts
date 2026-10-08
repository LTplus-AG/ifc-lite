/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { editHostedElementInStore, readHostedFill, readHostedElementSize } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { writeHostedEdit } from './model-authoring-hosted-edit';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : ''); return value.expressId;
};
async function exportedEntities(store: Awaited<ReturnType<typeof parseIfc>>, view: MutablePropertyView) {
  const parsed = await parseIfc(editedModelBytes(store, view));
  return [...parsed.entityIndex.byId.keys()].map(expressId => {
    const entity = parsed.getEntity(expressId); assert.ok(entity);
    return { expressId, type: entity.type, attributes: entity.attributes };
  });
}
async function fixture(kind: 'door' | 'opening' = 'door', sibling = false) {
  const { dataStore, view } = await seedAuthoringSample();
  const state = useViewerStore.getState(), storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const host = created(state.addWall(SAMPLE_MODEL, storey, { Start: [20, 20, 0], End: [32, 20, 0], Thickness: .25, Height: 4 }));
  const id = created(state.addHostedFill(SAMPLE_MODEL, host, { kind, params: { Offset: 2, Sill: .7, Width: 1, Height: 1.2, Name: 'Hosted refusal target' } }));
  if (sibling) created(useViewerStore.getState().addHostedFill(SAMPLE_MODEL, host, { kind: 'window', params: { Offset: 5, Sill: .7, Width: 1, Height: 1.2 } }));
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const binding = readHostedFill(saved, id); assert.ok(binding); assert.equal(binding.hostId, host); assert.equal(binding.offset, 2);
  const expected = { ...binding, location: binding.location.map(value => value * getModelLengthUnitScale(saved)), size: readHostedElementSize(saved, id) };
  const target = { modelId: SAMPLE_MODEL, globalId: saved.entities.getGlobalId(id), ifcClass: saved.entities.getTypeName(id), name: saved.entities.getName(id) };
  const batch = (edit: unknown, snapshot: unknown = expected) => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Canonical hosted refusal', units: 'm', frame: 'storey-local', operations: [{ op: 'hosted.edit', target, expected: snapshot, edit }] }));
  return { dataStore, view, saved, id, binding, expected, batch };
}

for (const refusal of ['bare-size', 'outside-length', 'outside-height', 'overlap'] as const)
test(`#7265 reviewed hosted ${refusal} retains the actual native refusal without publishing a draft`, async () => {
  const f = await fixture(refusal === 'bare-size' ? 'opening' : 'door', refusal === 'overlap');
  const edit = refusal === 'bare-size' ? { OverallWidth: 1.4 } : refusal === 'outside-length' ? { Offset: 20 } : refusal === 'outside-height' ? { OverallHeight: 10 } : { Offset: 5 };
  const nativeView = new MutablePropertyView(f.saved.properties, SAMPLE_MODEL), nativeEditor = new StoreEditor(f.saved, nativeView);
  const beforeNative = await exportedEntities(f.saved, nativeView);
  assert.throws(() => editHostedElementInStore(f.saved, nativeEditor, f.id, edit), /geometry|bounds|wall|fit|overlap|filling|door|window/i, 'real native writer establishes this refusal');
  assert.deepEqual(await exportedEntities(f.saved, nativeView), beforeNative, 'canonical failed native draft preserves every exported entity and value');
  const before = await exportedEntities(f.dataStore, f.view), preview = previewModelAuthoring(useViewerStore.getState(), f.batch(edit));
  assert.equal(preview.rows[0].status, 'invalid', preview.rows[0].issue ?? 'native hosted row status');
  assert.ok(preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'invalid hosted edit');
  assert.equal(result.ok, false);
  assert.deepEqual(await exportedEntities(f.dataStore, f.view), before, 'refused reviewed edit preserves every native exported entity and value');
});

for (const stale of ['binding', 'view-revision', 'source-replacement'] as const)
test(`#7265 hosted ${stale} refuses stale approval with stable exported native binding`, async () => {
  const f = await fixture(), state = useViewerStore.getState();
  const preview = previewModelAuthoring(state, f.batch({ Offset: 5 }, stale === 'binding' ? { ...f.expected, hostId: f.expected.hostId + 1 } : f.expected));
  if (stale === 'binding') assert.equal(preview.rows[0].status, 'conflict');
  else {
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native hosted row status');
    if (stale === 'view-revision') f.view.setProperty(f.id, 'UnrelatedEdit', 'Witness', true);
    else {
      assert.ok(f.dataStore.source);
      const replacement = await parseIfc(f.dataStore.source.materialize());
      useViewerStore.setState({ models: new Map([...state.models, [SAMPLE_MODEL, { ...state.models.get(SAMPLE_MODEL)!, ifcDataStore: replacement }]]) });
    }
  }
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'stale hosted edit');
  assert.equal(result.ok, false);
  const after = await parseIfc(editedModelBytes(f.dataStore, f.view));
  assert.deepEqual(readHostedFill(after, f.id), f.binding, 'stale review leaves actual native identity and placement unchanged');
});

test('#7265 explicit model ownership edits one of two native models sharing the same hosted GUID', async () => {
  const f = await fixture(), state = useViewerStore.getState();
  const other = { ...state.models.get(SAMPLE_MODEL)!, id: 'peer', name: 'peer.ifc', idOffset: 1_000_000, ifcDataStore: f.saved };
  const peerView = new MutablePropertyView(f.saved.properties, 'peer');
  useViewerStore.setState({ models: new Map([...state.models, ['peer', other]]), mutationViews: new Map([...state.mutationViews, ['peer', peerView]]) });
  const operation = f.batch({ Offset: 5 }).operations[0]; assert.equal(operation.op, 'hosted.edit');
  assert.ok(operation.op === 'hosted.edit');
  assert.equal(f.saved.entities.getGlobalId(f.id), operation.target.globalId);
  const peerBytes = editedModelBytes(f.saved, peerView), preview = previewModelAuthoring(useViewerStore.getState(), f.batch({ Offset: 5 }));
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native hosted row status');
  assert.equal(preview.rows[0].modelId, SAMPLE_MODEL);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'federated hosted edit');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(f.dataStore, f.view));
  assert.equal(readHostedFill(after, f.id)?.offset, 5);
  assert.deepEqual(editedModelBytes(f.saved, peerView), peerBytes, 'same-GUID peer receives no writes');
  assert.deepEqual(readHostedFill(await parseIfc(peerBytes), f.id), f.binding);
});

test('#7265 hosted preview reports unavailable after an earlier host transform instead of drawing stale source bounds', async () => {
  const f = await fixture(), state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL)!;
  const moved = { op: 'element.move', target: { modelId: SAMPLE_MODEL, globalId: f.saved.entities.getGlobalId(f.binding.hostId), ifcClass: 'IfcWall', name: f.saved.entities.getName(f.binding.hostId) }, delta: [1, 0] };
  const batch = parseModelAuthoringBatch(JSON.stringify({ ...f.batch({ Offset: 5 }), operations: [moved, ...f.batch({ Offset: 5 }).operations] }));
  assert.ok(model.ifcDataStore);
  const preview = previewModelAuthoring(state, batch);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined], ['ready', undefined]], 'both native operations admit the public authored host and filling');
  assert.equal(preview.rows[1].previewUnavailable, true, 'a ghost drawn from the original source would omit the prior host transform');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'native host transform and hosted edit');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(f.dataStore, f.view));
  assert.equal(readHostedFill(after, f.id)?.offset, 5);
});

test('#7265 source-free transport refuses hosted geometry editing despite retained parsed getters', async () => {
  const f = await fixture(), state = useViewerStore.getState();
  const model = state.models.get(SAMPLE_MODEL)!;
  // A transport can retain the parsed index/getter closure while omitting the
  // geometry source. The existing native UI gate must stay authoritative.
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: { ...f.dataStore, source: EMPTY_SOURCE_BYTES } }]]) });
  const count = f.view.getMutationCount(), preview = previewModelAuthoring(useViewerStore.getState(), f.batch({ Offset: 5 }));
  assert.equal(preview.rows[0].status, 'unsupported'); assert.match(preview.rows[0].issue ?? '', /source|IFC/i);
  assert.equal(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'source-free hosted edit').ok, false);
  assert.equal(f.view.getMutationCount(), count);
  assert.deepEqual(readHostedFill(await parseIfc(editedModelBytes(f.dataStore, f.view)), f.id), f.binding);
});

test('#7265 a native same-model duplicate IfcRoot GUID refuses hosted editing before any writes', async () => {
  const f = await fixture();
  const op = f.batch({ Sill: .9 }).operations[0]; assert.ok(op.op === 'hosted.edit');
  const editor = new StoreEditor(f.dataStore, f.view);
  const psetId = f.dataStore.entityIndex.byType.get('IFCPROPERTYSET')?.[0]; assert.ok(psetId);
  const pset = f.dataStore.getEntity(psetId); assert.ok(pset);
  assert.ok(Array.isArray(pset.attributes[4]) && pset.attributes[4].length > 0, 'native duplicate control preserves an existing nonempty property set shape');
  const duplicate = editor.addEntity('IfcPropertySet', [op.target.globalId, ...pset.attributes.slice(1)]);
  const saved = await parseIfc(editedModelBytes(f.dataStore, f.view));
  assert.equal(saved.getEntity(duplicate.expressId)?.attributes[0], op.target.globalId);
  assert.equal(saved.getEntity(f.id)?.attributes[0], op.target.globalId);
  const before = await exportedEntities(f.dataStore, f.view);
  const preview = previewModelAuthoring(useViewerStore.getState(), f.batch({ Sill: .9 }));
  assert.equal(preview.rows[0].status, 'ambiguous-target', preview.rows[0].issue);
  assert.throws(() => editor.runAtomic(draft => writeHostedEdit(f.batch({ Sill: .9 }), f.dataStore, draft, f.id, op.expected, op.edit, op.target.globalId)), /GlobalId is not unique/, 'the canonical draft inventory also guards native writing');
  assert.deepEqual(await exportedEntities(f.dataStore, f.view), before);
});

for (const transport of ['live', 'saved', 'saved-deleted-material'] as const)
test(`#7265 ${transport} non-root material Name collision retains real hosted edit, export and Undo`, async () => {
  const f = await fixture();
  const op = f.batch({ Sill: .9 }).operations[0]; assert.ok(op.op === 'hosted.edit');
  const material = new StoreEditor(f.dataStore, f.view).addEntity('IfcMaterial', [op.target.globalId, null, null]);
  const saved = await parseIfc(editedModelBytes(f.dataStore, f.view));
  assert.equal(saved.getEntity(material.expressId)?.attributes[0], op.target.globalId);
  assert.equal(saved.getEntity(f.id)?.attributes[0], op.target.globalId);
  const source = transport === 'live' ? f.dataStore : saved;
  const view = transport === 'live' ? f.view : new MutablePropertyView(saved.properties, SAMPLE_MODEL);
  if (transport === 'saved-deleted-material') assert.equal(new StoreEditor(source, view).removeEntity(material.expressId), true);
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL); assert.ok(model);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]),
    mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map() });
  const before = await exportedEntities(source, view);
  const preview = previewModelAuthoring(useViewerStore.getState(), f.batch({ Sill: .9 }));
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'non-root hosted identity');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const after = await parseIfc(editedModelBytes(source, view));
  assert.equal(readHostedFill(after, f.id)?.sill, .9);
  assert.equal(after.getEntity(material.expressId)?.attributes[0], transport === 'saved-deleted-material' ? undefined : op.target.globalId);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.deepEqual(await exportedEntities(source, view), before, 'one grouped Undo preserves the original native graph and prior material deletion');
});
