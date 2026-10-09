/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createCostBackend } from '@ifc-lite/sdk';
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
  const review = prepareCostReview(useViewerStore, input());
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
