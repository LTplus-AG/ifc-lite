/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createCostBackend, createCostStoreBackend } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseCostProposal } from './cost-graph-proposal';
import { nativeCostEvidence } from './cost-graph-evidence';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { prepareCostReview } from './cost-graph-review';

// Campaign6812 P15A audit only: all amounts and quantities below are explicitly
// supplied test inputs. No currency, rate derivation or cost estimate is inferred.
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
async function nativeGraph() {
  const { dataStore, view } = await seedAuthoringSample();
  const baseline = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data();
  const refs = recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, draft) => {
    const cost = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: draft.getMutationView() }));
    const write = createCostStoreBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, editor: draft, mutationView: draft.getMutationView(), ownerHistoryId: null }), cost);
    const schedule = write.addCostSchedule(SAMPLE_MODEL, { Name: 'Supplied audit schedule', Identification: 'AUDIT', PredefinedType: 'TENDER' });
    const value = write.addCostValue(SAMPLE_MODEL, { Name: 'Supplied amount', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 42 }, Category: 'Supplied' });
    const quantity = write.addCostQuantity(SAMPLE_MODEL, { Kind: 'IfcQuantityArea', Name: 'Supplied area', Value: 7, Unit: 16 });
    const parent = write.addCostItem(SAMPLE_MODEL, { Name: 'Supplied parent' });
    const item = write.addCostItem(SAMPLE_MODEL, { Name: 'Supplied child', CostQuantities: [quantity.expressId] });
    write.setCostItemValues(SAMPLE_MODEL, item.expressId, [value.expressId]);
    write.nestCostItems(SAMPLE_MODEL, parent.expressId, [item.expressId]);
    write.assignCostItemsToSchedule(SAMPLE_MODEL, schedule.expressId, [parent.expressId]);
    write.assignToCostItem(SAMPLE_MODEL, item.expressId, [291]);
    return { schedule, value, quantity, parent, item };
  }, 'supplied-cost-audit');
  const graph = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data();
  assert.equal(graph.CostSchedules.find(row => row.ref.expressId === refs.schedule.expressId)?.Name, 'Supplied audit schedule');
  assert.equal(graph.CostValues.find(row => row.ref.expressId === refs.value.expressId)?.AppliedValue?.Kind, 'Typed');
  assert.equal(graph.CostQuantities.find(row => row.ref.expressId === refs.quantity.expressId)?.AreaValue, '7.');
  assert.equal(graph.CostQuantities.find(row => row.ref.expressId === refs.quantity.expressId)?.Unit?.expressId, 16);
  assert.ok(graph.Relationships.some(row => row.Type === 'IfcRelNests' && row.RelatingObject?.expressId === refs.parent.expressId && row.RelatedObjects?.some(ref => ref.expressId === refs.item.expressId)));
  assert.ok(graph.Relationships.some(row => row.Type === 'IfcRelAssignsToControl' && row.RelatingControl?.expressId === refs.item.expressId && row.RelatedObjects?.some(ref => ref.expressId === 291)));
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const savedStore = await parseIfc(bytes);
  const saved = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: savedStore })).data();
  assert.equal(saved.CostItems.find(row => row.Name === 'Supplied child')?.CostValues?.[0]?.expressId, refs.value.expressId);
  assert.equal(saved.CostQuantities.find(row => row.Name === 'Supplied area')?.AreaValue, '7.');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const undone = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data();
  assert.equal(undone.CostItems.length, baseline.CostItems.length);
  assert.equal(undone.CostValues.length, baseline.CostValues.length);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostItems.length, graph.CostItems.length);
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, draft) => {
    const cost = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: draft.getMutationView() }));
    const write = createCostStoreBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, editor: draft, mutationView: draft.getMutationView(), ownerHistoryId: null }), cost);
    assert.throws(() => write.removeCostEntity(SAMPLE_MODEL, refs.value.expressId), /referenced/);
    write.removeCostEntity(SAMPLE_MODEL, refs.item.expressId, { detach: true });
  }, 'supplied-cost-remove-audit');
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostItems.some(row => row.ref.expressId === refs.item.expressId), false);
  const removed = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(removed)), []);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostItems.some(row => row.ref.expressId === refs.item.expressId), true);
  return refs;
}
test('Campaign6812 supplied native cost graph creates/nests/assigns/attaches and removes with STEP/one-batch Undo', async () => { await nativeGraph(); });
test('#7311 actual supported native supplied schedule admits a detached review without editing the IFC', async () => {
  await nativeGraph();
  const state = useViewerStore.getState();
  const expected = nativeCostEvidence(readOnlyModelEditTarget(state, SAMPLE_MODEL), 291).expected;
  assert.ok(expected);
  const proposal = parseCostProposal(JSON.stringify({ version: 1, kind: 'cost.graph', title: 'Supplied schedule', modelId: SAMPLE_MODEL, expected,
    operations: [{ op: 'cost.schedule.create', ref: 'schedule', params: { Name: 'Reviewed supplied schedule', Identification: 'AUDIT', PredefinedType: 'TENDER' } }] }));
  const view = state.mutationViews.get(SAMPLE_MODEL)!;
  const bytes = editedModelBytes(state.models.get(SAMPLE_MODEL)!.ifcDataStore!, view);
  const history = state.undoStacks.get(SAMPLE_MODEL)?.length;
  const review = prepareCostReview(useViewerStore, proposal);
  assert.equal(review.delta.filter(row => !row.before && row.after?.type === 'IfcCostSchedule').length, 1);
  assert.deepEqual(editedModelBytes(state.models.get(SAMPLE_MODEL)!.ifcDataStore!, view), bytes);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, history);
  const result = review.commit();
  assert.equal(result.rows.length, 1);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: state.models.get(SAMPLE_MODEL)!.ifcDataStore!, mutationView: view })).data().CostSchedules.some(row => row.Name === 'Reviewed supplied schedule'), true);
  assert.throws(() => review.commit(), /already been applied/);
});
