/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createCostBackend } from '@ifc-lite/sdk';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { parseCostProposal, type CostOperation } from './cost-graph-proposal';
import { prepareCostReview } from './cost-graph-review';
import { commitReviewedCost } from './cost-graph-receipt';
import { undoModelChanges } from './model-change-commit';
import { decodeModelChangeReceipt } from './receipts';
import { readCostSnapshot, nativeCostEvidence } from './cost-graph-evidence';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
const nativeRef = (ref: string) => ({ ref });
const operations: CostOperation[] = [
  { op: 'cost.schedule.create', ref: 'schedule', params: { Name: 'Reviewed supplied schedule', PredefinedType: 'TENDER' } },
  { op: 'cost.value.create', ref: 'value', params: { Name: 'Supplied 42', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 42 }, Category: 'Supplied' } },
  { op: 'cost.quantity.create', ref: 'quantity', params: { Kind: 'IfcQuantityArea', Name: 'Supplied 7', Value: 7, Unit: 16 } },
  { op: 'cost.item.create', ref: 'parent', params: { Name: 'Reviewed parent' } },
  { op: 'cost.item.create', ref: 'child', params: { Name: 'Reviewed child', CostQuantities: [nativeRef('quantity')] } },
  { op: 'cost.item.values', target: nativeRef('child'), related: [nativeRef('value')] },
  { op: 'cost.items.nest', target: nativeRef('parent'), related: [nativeRef('child')] },
  { op: 'cost.schedule.assign', target: nativeRef('schedule'), related: [nativeRef('parent')] },
  { op: 'cost.item.assign', target: nativeRef('child'), related: [291] },
];
function input(ops = operations) {
  const target = readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!;
  return parseCostProposal(JSON.stringify({ version: 1, kind: 'cost.graph', title: 'Explicit native supplied graph', modelId: SAMPLE_MODEL,
    expected: readCostSnapshot(target, [291]), operations: ops }));
}
test('#7311 all nine native supplied Cost routes retain typed amounts/declared units in IFC export and receipt grouped Undo/Redo', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const before = editedModelBytes(dataStore, view);
  const baselineHistory = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;
  const revision = view.getMutationRevision();
  const held = view.prepareAtomic(() => null);
  const editors = useViewerStore.getState().storeEditors;
  const review = prepareCostReview(useViewerStore, input());
  held.validate();
  assert.equal(useViewerStore.getState().storeEditors, editors);
  assert.equal(editors.size, 0, 'read-only preparation must not cache a live editor');
  assert.equal(view.getMutationRevision(), revision, 'detached graph preview must not alter the live allocator or metadata');
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, baselineHistory);
  assert.deepEqual(editedModelBytes(dataStore, view), before);
  const receipt = commitReviewedCost(useViewerStore, review, 'real supplied fixture');
  assert.deepEqual(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt))), receipt, 'native receipt is portable and preserves real non-root expressIds');
  const valueReceipt = receipt.applied.find(row => row.op === 'cost.value.create')!;
  assert.equal(valueReceipt.globalId, '', 'IfcCostValue has no GlobalId; no invented identity');
  assert.ok(valueReceipt.expressId);
  const bytes = editedModelBytes(dataStore, view), source = new TextDecoder().decode(bytes);
  assert.match(source, /IFCMONETARYMEASURE\(42\.\)/, 'independent STEP preserves the explicitly supplied typed monetary value');
  assert.deepEqual(danglingReferences(source), []);
  const saved = await parseIfc(bytes), graph = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: saved })).data();
  assert.equal(graph.CostItems.find(row => row.Name === 'Reviewed child')?.CostValues?.[0]?.expressId, valueReceipt.expressId);
  assert.equal(graph.CostQuantities.find(row => row.Name === 'Supplied 7')?.Unit?.expressId, 16);
  assert.ok(graph.Relationships.some(row => row.Type === 'IfcRelAssignsToControl' && row.RelatedObjects?.some(ref => ref.expressId === 291)));
  const child = graph.CostItems.find(row => row.Name === 'Reviewed child')!;
  const removal = prepareCostReview(useViewerStore, input([{ op: 'cost.remove', target: child.ref.expressId, detach: true }]));
  assert.ok(removal.delta.some(row => row.expressId === child.ref.expressId && !row.after), 'review shows native cascade/deletion before Apply');
  const removedReceipt = commitReviewedCost(useViewerStore, removal, 'reviewed native detach');
  assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(dataStore, view))), []);
  assert.ok(undoModelChanges(useViewerStore, removedReceipt).ok);
  assert.ok(undoModelChanges(useViewerStore, receipt).ok, 'one original native group removes the full supplied graph');
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostSchedules.length, 0);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostItems.length, 2);
});
test('#7311 selective approval refuses missing earlier refs and unrelated/unrecorded expressIds without mutation', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const baseline = editedModelBytes(dataStore, view);
  assert.throws(() => prepareCostReview(useViewerStore, input(), new Set([4])), /Approve the earlier creation/);
  const original = input();
  const altered = { ...original, operations: [{ op: 'cost.item.assign' as const, target: 999999, related: [291] }] };
  assert.throws(() => prepareCostReview(useViewerStore, altered), /was not captured/);
  assert.deepEqual(editedModelBytes(dataStore, view), baseline);
  const review = prepareCostReview(useViewerStore, input(), new Set([0]));
  const receipt = commitReviewedCost(useViewerStore, review, 'only explicit schedule approved');
  assert.equal(receipt.applied.length, 1);
  assert.equal(receipt.skipped.length, operations.length - 1);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostItems.length, 0);
});
test('#7311 native graph/source lease rejects skip-history edits, source replacement and mutated proposal at Apply', async () => {
  const { view } = await seedAuthoringSample();
  const review = prepareCostReview(useViewerStore, input());
  view.setPositionalAttribute(291, 2, 'Changed target', true);
  assert.throws(() => review.commit(), /changed after review/);
  await seedAuthoringSample();
  const replacement = prepareCostReview(useViewerStore, input());
  await seedAuthoringSample();
  assert.throws(() => replacement.commit(), /changed after review/);
  const mutated = prepareCostReview(useViewerStore, input());
  mutated.proposal.operations[0].params!.Name = 'Not approved';
  assert.throws(() => mutated.commit(), /proposal changed/);
});
test('#7311 absent native source explicitly refuses complete Cost evidence instead of publishing zero costs', async () => {
  await seedAuthoringSample();
  const target = readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!;
  assert.equal(nativeCostEvidence(target, 291).status, 'available');
  // Immutable native source replacement is exercised elsewhere; this fixture intentionally exposes no bytes.
  const empty = { ...target, dataStore: { ...target.dataStore, source: { ...target.dataStore.source, byteLength: 0 } } };
  assert.deepEqual(nativeCostEvidence(empty as unknown as typeof target, 291), { status: 'unavailable-source', recordCount: null, expected: null });
});
test('#7311 explicit selection grounding publishes the same complete canonical native Cost graph', async () => {
  await seedAuthoringSample();
  const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, maxExpressId: Math.max(...model.ifcDataStore!.entityIndex.byId.keys()) }]]), selectedEntityIds: new Set([291]), selectedEntityId: 291 });
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements.length, 1);
  assert.equal(grounding.elements[0].nativeCost.status, 'available');
  assert.deepEqual(JSON.parse(JSON.stringify(grounding.elements[0].nativeCost.expected)), input().expected);
});

test('#7311 first-read model without a live view remains pure until an explicit native Apply', async () => {
  const { dataStore } = await seedAuthoringSample();
  const emptyViews = new Map();
  useViewerStore.setState({ mutationViews: emptyViews });
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL);
  const proposal = input([{ op: 'cost.schedule.create', params: { Name: 'First-read explicit native schedule' } }]);
  const review = prepareCostReview(useViewerStore, proposal);
  assert.equal(useViewerStore.getState().mutationViews, emptyViews);
  assert.equal(emptyViews.size, 0);
  assert.equal(useViewerStore.getState().storeEditors.size, 0);
  assert.equal(useViewerStore.getState().models.get(SAMPLE_MODEL), model);
  const receipt = commitReviewedCost(useViewerStore, review, 'first read Apply');
  assert.equal(receipt.applied.length, 1);
  const live = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!;
  const saved = await parseIfc(editedModelBytes(dataStore, live));
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: saved })).data().CostSchedules[0].Name, 'First-read explicit native schedule');
});
test('#7311 unsupported schema, SELECT, list/cycle and missing expected graph refuse through canonical native validation', async () => {
  await seedAuthoringSample();
  assert.throws(() => parseCostProposal(JSON.stringify({ version: 1, kind: 'cost.graph', modelId: SAMPLE_MODEL, title: 'Missing expected', operations })), /complete current/);
  assert.throws(() => parseCostProposal(JSON.stringify({ ...input(), currency: 'invented' })), /currency/);
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.value.create', params: { AppliedValue: { Type: 'InventedCurrencyMeasure', Value: 42 } } }])), /unsupported|Type|measure/i);
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.item.create', params: { Name: 'Malformed empty source list', CostValues: [] } }])), /empty|CostValues/i);
  const cyclic: CostOperation[] = [{ op: 'cost.item.create', ref: 'a', params: { Name: 'A' } }, { op: 'cost.item.create', ref: 'b', params: { Name: 'B' } },
    { op: 'cost.items.nest', target: nativeRef('a'), related: [nativeRef('b')] }, { op: 'cost.items.nest', target: nativeRef('b'), related: [nativeRef('a')] }];
  assert.throws(() => prepareCostReview(useViewerStore, input(cyclic)), /cycle/i);
  useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!.schemaVersion = 'IFC2X3';
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.schedule.create', params: { Name: 'Unsupported native schema' } }])), /IFC2X3/);
});
test('#7311 full expected graph and approved choices cannot be altered after native review', async () => {
  await seedAuthoringSample();
  const review = prepareCostReview(useViewerStore, input(), new Set([0]));
  review.snapshot.selected.push(999999);
  assert.throws(() => review.commit(), /choices or native delta changed/);
});
test('#7311 original zero monetary/quantity values retain exact IFC SELECT and absence-versus-empty semantics', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const review = prepareCostReview(useViewerStore, input([
    { op: 'cost.value.create', params: { Name: '', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 0 } } },
    { op: 'cost.quantity.create', params: { Name: 'Explicit zero count', Kind: 'IfcQuantityCount', Value: 0 } },
  ]));
  commitReviewedCost(useViewerStore, review, 'supplied zero controls');
  const source = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.match(source, /IFCMONETARYMEASURE\(0\.\)/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const graph = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: parsed })).data();
  assert.equal(graph.CostValues[0].Name, '');
  assert.equal(graph.CostValues[0].Components, undefined);
  // Unattached quantities are ordinary native entities, not invented graph membership.
  const quantity = review.delta.find(row => row.after?.type === 'IfcQuantityCount')!;
  assert.equal(parsed.getEntity(quantity.expressId)?.attributes[3], 0);
});

test('#7311 federation keeps supplied native Cost writes and history within the explicitly named model', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const second = await parseIfc(editedModelBytes(dataStore, view));
  const sourceModel = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const modelId = 'second-cost-source';
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, sourceModel], [modelId, { ...sourceModel, id: modelId, name: modelId, idOffset: 1000000, ifcDataStore: second }]]) });
  const target = readOnlyModelEditTarget(useViewerStore.getState(), modelId)!;
  const proposal = parseCostProposal(JSON.stringify({ version: 1, kind: 'cost.graph', title: 'Supplied secondary graph', modelId,
    expected: readCostSnapshot(target, [291]), operations: [{ op: 'cost.schedule.create', params: { Name: 'Only secondary schedule' } }] }));
  const primaryBytes = editedModelBytes(dataStore, view);
  const receipt = commitReviewedCost(useViewerStore, prepareCostReview(useViewerStore, proposal), 'explicit federation model');
  assert.equal(receipt.batches[0].modelId, modelId);
  assert.deepEqual(editedModelBytes(dataStore, view), primaryBytes);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, 0);
  const parsed = await parseIfc(editedModelBytes(second, useViewerStore.getState().mutationViews.get(modelId)!));
  assert.equal(createCostBackend(() => ({ modelId, store: parsed })).data().CostSchedules[0].Name, 'Only secondary schedule');
  assert.ok(undoModelChanges(useViewerStore, receipt).ok);
});
test('#7311 current named/positional Cost record edits match actual STEP, then stale expectation is refused', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const created = commitReviewedCost(useViewerStore, prepareCostReview(useViewerStore, input()), 'native current graph');
  const valueId = created.applied.find(row => row.op === 'cost.value.create')!.expressId!;
  const old = input([{ op: 'cost.remove', target: valueId, detach: true }]);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!;
  editor.setAttribute(valueId, 'Name', 'Current non-root amount');
  view.setPositionalAttribute(valueId, 2, { typed: { type: 'IfcMonetaryMeasure', value: 64 } });
  const source = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.match(source, /IFCMONETARYMEASURE\(64\.\)/);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const exported = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: saved })).data();
  const current = readCostSnapshot(readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!, [291]);
  assert.deepEqual(current.graph.CostValues, exported.CostValues);
  assert.equal(current.graph.CostValues.find(row => row.ref.expressId === valueId)?.Name, 'Current non-root amount');
  assert.throws(() => prepareCostReview(useViewerStore, old), /differs from the current native source/);
});
test('#7311 shared values and non-cost incoming references remain visible and constrain native safe removal', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const proposal = input([{ op: 'cost.value.create', ref: 'shared', params: { Name: 'Supplied shared amount', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 42 } } },
    { op: 'cost.item.create', params: { Name: 'First shared item', CostValues: [nativeRef('shared')] } },
    { op: 'cost.item.create', params: { Name: 'Second shared item', CostValues: [nativeRef('shared')] } }]);
  const receipt = commitReviewedCost(useViewerStore, prepareCostReview(useViewerStore, proposal), 'shared value');
  const valueId = receipt.applied[0].expressId!, first = receipt.applied[1].expressId!;
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.remove', target: valueId }])), /referenced/);
  const metric = new StoreEditor(dataStore, view).addEntity('IfcMetric', ['Native threshold', null, '.NOTDEFINED.', null, null, null, null, '.EQUALTO.', null, `#${valueId}`, null]);
  const snapshot = readCostSnapshot(readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!, [291]);
  assert.ok(snapshot.incoming.find(row => row.target === valueId)?.referrers.some(row => row.expressId === metric.expressId));
  assert.ok(snapshot.records.some(row => row.expressId === metric.expressId && row.type === 'IfcMetric'));
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.remove', target: valueId, detach: true }])), /outside|unknown|IfcMetric|referenced/i);
  const removeItem = prepareCostReview(useViewerStore, input([{ op: 'cost.remove', target: first, detach: true }]));
  assert.equal(removeItem.delta.some(row => row.expressId === valueId && !row.after), false, 'shared/unrelated native references prevent value cascade');
  commitReviewedCost(useViewerStore, removeItem, 'remove only approved first item');
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(dataStore, view))), []);
  assert.equal(saved.getEntity(valueId)?.type.toUpperCase(), 'IFCCOSTVALUE');
  assert.equal(saved.getEntity(metric.expressId)?.type.toUpperCase(), 'IFCMETRIC');
});
test('#7311 native permission and same-model Root GlobalId ambiguity refuse Cost binding without changing graph', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const editor = new StoreEditor(dataStore, view);
  const native = dataStore.getEntity(291)!;
  editor.addEntity('IfcWall', native.attributes);
  assert.throws(() => prepareCostReview(useViewerStore, input([{ op: 'cost.item.create', ref: 'item', params: { Name: 'Binding control' } },
    { op: 'cost.item.assign', target: nativeRef('item'), related: [291] }])), /ambiguous GlobalId/);
  const proposal = input([{ op: 'cost.schedule.create', params: { Name: 'Permission control' } }]);
  const review = prepareCostReview(useViewerStore, proposal);
  const baseline = editedModelBytes(dataStore, view);
  useViewerStore.setState({ editEnabled: false });
  assert.throws(() => review.commit(), /Edit mode/);
  assert.deepEqual(editedModelBytes(dataStore, view), baseline);
});
test('#7311 malformed current Root identity cannot authorize a native Cost assignment', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  view.setAttribute(291, 'GlobalId', 'not-an-ifc-guid');
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.getEntity(291)?.attributes[0], 'not-an-ifc-guid', 'actual STEP export/reparse proves the current malformed identity before admission');
  const proposal = input([{ op: 'cost.item.create', ref: 'item', params: { Name: 'Invalid current identity control' } },
    { op: 'cost.item.assign', target: nativeRef('item'), related: [291] }]);
  assert.throws(() => prepareCostReview(useViewerStore, proposal), /GlobalId|Root identity/);
});
