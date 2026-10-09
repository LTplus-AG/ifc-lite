/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { asSourceBytes, effectiveMetadataRecord, extractStructuralOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { readStructuralSnapshot, nativeStructuralEvidence } from './structural-graph-evidence';
import { parseStructuralProposal, type StructuralOperation } from './structural-graph-proposal';
import { prepareStructuralReview } from './structural-graph-review';
import { commitReviewedStructural } from './structural-graph-receipt';
import { decodeModelChangeReceipt } from './receipts';
import { undoModelChanges } from './model-change-commit';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
async function setup() {
  const fixture = await seedAuthoringSample(), storey = fixture.dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  return { ...fixture, storey };
}
function proposal(storey: number, operations: StructuralOperation[], modelId = SAMPLE_MODEL) {
  const expected = readStructuralSnapshot(readOnlyModelEditTarget(useViewerStore.getState(), modelId)!, [storey]);
  return parseStructuralProposal(JSON.stringify({ version: 1, kind: 'structural.graph', title: 'Explicit supplied analytical graph', modelId, nativeMeasuresAcknowledged: true, expected, operations }));
}
function full(storey: number): StructuralOperation[] { return [
  { op: 'structural.group.create', ref: 'loads', params: { Name: 'Reviewed supplied load group', ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', PredefinedType: 'LOAD_GROUP' } },
  { op: 'structural.analysis.create', ref: 'analysis', params: { Name: 'Reviewed supplied analysis', PredefinedType: 'LOADING_3D', LoadGroupIds: [{ ref: 'loads' }] } },
  { op: 'structural.member.create', ref: 'member', storey, params: { Name: 'Reviewed supplied member', Start: [0, 0, 0], End: [4, 0, 0], PredefinedType: 'RIGID_JOINED_MEMBER' } },
  { op: 'structural.connection.create', ref: 'connection', storey, params: { Name: 'Reviewed supplied connection', Position: [4, 0, 0], BoundaryCondition: { Name: 'Supplied restraint', TranslationalStiffnessX: true, RotationalStiffnessX: false } } },
  { op: 'structural.pointAction.create', ref: 'point', params: { Name: 'Reviewed supplied point', GlobalOrLocal: 'GLOBAL_COORDS', ForceZ: -1000, ForceX: 0 } },
  { op: 'structural.linearAction.create', ref: 'linear', params: { Name: 'Reviewed supplied linear', GlobalOrLocal: 'LOCAL_COORDS', LinearForceZ: -200, LinearMomentX: 0 } },
  { op: 'structural.member.connect', target: { ref: 'member' }, related: [{ ref: 'connection' }] },
  { op: 'structural.activity.connect', target: { ref: 'connection' }, related: [{ ref: 'point' }] },
  { op: 'structural.activity.connect', target: { ref: 'member' }, related: [{ ref: 'linear' }] },
  { op: 'structural.group.assign', target: { ref: 'analysis' }, related: [{ ref: 'member' }, { ref: 'connection' }] },
  { op: 'structural.group.assign', target: { ref: 'loads' }, related: [{ ref: 'point' }, { ref: 'linear' }] },
]; }
const analysis = (Name: string): StructuralOperation => ({ op: 'structural.analysis.create', params: { Name, PredefinedType: 'LOADING_3D' } });
test('#7318 all nine reviewed native factories export supplied graph, load zero, restraint SELECTs and one grouped receipt Undo/Redo', async () => {
  const { dataStore, view, storey } = await setup(), held = view.prepareAtomic(() => null);
  const before = editedModelBytes(dataStore, view), history = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length;
  const review = prepareStructuralReview(useViewerStore, proposal(storey, full(storey)));
  held.validate();
  assert.deepEqual(editedModelBytes(dataStore, view), before);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, history);
  assert.equal(useViewerStore.getState().storeEditors.size, 0, 'native preparation does not allocate a live editor');
  const receipt = commitReviewedStructural(useViewerStore, review, 'native audit');
  assert.ok(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt))));
  const bytes = editedModelBytes(dataStore, view), text = new TextDecoder().decode(bytes);
  assert.deepEqual(danglingReferences(text), []);
  const graph = extractStructuralOnDemand(await parseIfc(bytes));
  const [model] = graph.analysisModels, [member] = graph.members, [connection] = graph.connections, [group] = graph.loadGroups;
  assert.equal(model.name, 'Reviewed supplied analysis');
  assert.deepEqual(model.itemGlobalIds.sort(), [member.globalId, connection.globalId].sort());
  assert.deepEqual(model.loadGroupGlobalIds, [group.globalId]);
  assert.deepEqual(member.connectionGlobalIds, [connection.globalId]);
  assert.equal(connection.appliedCondition?.components.TranslationalStiffnessX, true);
  assert.equal(connection.appliedCondition?.components.RotationalStiffnessX, false);
  assert.equal(graph.activities.find(row => row.type === 'IfcStructuralPointAction')?.appliedLoad?.components.ForceX, 0);
  assert.equal(graph.activities.find(row => row.type === 'IfcStructuralPointAction')?.appliedLoad?.components.ForceZ, -1000);
  assert.equal(graph.activities.find(row => row.type === 'IfcStructuralLinearAction')?.appliedLoad?.components.LinearForceZ, -200);
  assert.equal(group.activityGlobalIds.length, 2);
  assert.equal(receipt.applied.length, 11);
  assert.throws(() => review.commit(), /already/);
  assert.equal(undoModelChanges(useViewerStore, receipt).ok, true);
  assert.equal(extractStructuralOnDemand(dataStore, view).members.length, 0);
  assert.equal(extractStructuralOnDemand(dataStore, view).activities.length, 0);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.equal(extractStructuralOnDemand(dataStore, view).members.length, 1);
});
test('#7318 selective approval cannot reuse an unapproved owner, wrong SELECT reference, or source-uncaptured ID', async () => {
  const { dataStore, view, storey } = await setup();
  const input = proposal(storey, full(storey));
  assert.throws(() => prepareStructuralReview(useViewerStore, input, new Set([1])), /earlier|reference/);
  assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [{ op: 'structural.member.connect', target: storey, related: [storey] }])), /IfcStructuralMember/);
  assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [{ op: 'structural.group.assign', target: 999999, related: [storey] }])), /reference/);
  const receipt = commitReviewedStructural(useViewerStore, prepareStructuralReview(useViewerStore, input, new Set([0])), 'one chosen owner');
  assert.equal(receipt.applied.length, 1);
  const graph = extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view)));
  assert.equal(graph.loadGroups.length, 1); assert.equal(graph.analysisModels.length, 0); assert.equal(graph.members.length, 0);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view))).loadGroups.length, 0);
  assert.equal((await parseIfc(editedModelBytes(dataStore, view))).entities.getGlobalId(291), dataStore.entities.getGlobalId(291));
});
test('#7318 stale source, history-free native edits, proposal choices and permissions refuse before writes', async () => {
  const { dataStore, view, storey } = await setup();
  let review = prepareStructuralReview(useViewerStore, proposal(storey, [analysis('Supplied source check')]));
  view.setAttribute(291, 'Description', 'New source state', true);
  assert.throws(() => review.commit(), /changed|differs/);
  review = prepareStructuralReview(useViewerStore, proposal(storey, [analysis('Supplied permission check')]));
  useViewerStore.setState({ editEnabled: false }); assert.throws(() => review.commit(), /Edit|permission|read.only/i);
  useViewerStore.setState({ editEnabled: true });
  review = prepareStructuralReview(useViewerStore, proposal(storey, [analysis('Supplied choice check')]));
  review.delta[0].after!.attributes[2] = 'Changed after review'; assert.throws(() => review.commit(), /choices|delta changed/);
  const before = editedModelBytes(dataStore, view);
  review = prepareStructuralReview(useViewerStore, proposal(storey, [analysis('Supplied replacement check')]));
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model }]]) });
  assert.throws(() => review.commit(), /source|changed/); assert.deepEqual(editedModelBytes(dataStore, view), before);
});
test('#7318 absent source and missing native-measure acknowledgement cannot certify or authorize a complete analytical graph', async () => {
  const { dataStore, storey } = await setup(), input = proposal(storey, [analysis('Native measure check')]);
  assert.throws(() => parseStructuralProposal(JSON.stringify({ ...input, nativeMeasuresAcknowledged: false })), /acknowledge/);
  const source = dataStore.source; dataStore.source = asSourceBytes(source.slice(0, 0));
  const evidence = nativeStructuralEvidence(readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL), storey);
  assert.equal(evidence.status, 'unavailable-source'); assert.equal(evidence.recordCount, null); assert.equal(evidence.expected, null);
  assert.throws(() => prepareStructuralReview(useViewerStore, input), /source/);
  dataStore.source = source;
});
test('#7318 changed named and positional source storey frames refuse creation after independent IFC export control', async () => {
  for (const field of ['PlacementRelTo', '@0']) {
    const { dataStore, view, storey } = await setup();
    const source = effectiveMetadataRecord(dataStore, storey, view)!;
    const placement = Number(String(source.attributes[5]).replace('#', ''));
    assert.ok(placement > 0);
    const operation: StructuralOperation = { op: 'structural.member.create', storey, params: { Name: 'Supplied current frame', Start: [0, 0, 0], End: [4, 0, 0] } };
    assert.ok(prepareStructuralReview(useViewerStore, proposal(storey, [operation])).delta.length);
    if (field === '@0') view.setPositionalAttribute(placement, 0, null);
    else view.setAttribute(placement, field, '$', true);
    assert.equal((await parseIfc(editedModelBytes(dataStore, view))).getEntity(placement)?.attributes[0], null, 'actual native STEP/reparse confirms the current placement retarget before review refuses it');
    assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [operation])), /frame|placement/);
  }
});
test('#7318 native schema/enum/SELECT and coordinate/load invariants preserve source bytes when supplied values are invalid', async () => {
  const { dataStore, view, storey } = await setup(), before = editedModelBytes(dataStore, view);
  for (const operation of [
    { op: 'structural.analysis.create', params: { Name: 'Bad enum', PredefinedType: 'INVENTED' } },
    { op: 'structural.pointAction.create', params: { Name: 'Missing supplied load' } },
    { op: 'structural.member.create', storey, params: { Name: 'Zero length', Start: [0, 0, 0], End: [0, 0, 0] } },
  ] as StructuralOperation[]) { assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [operation])), /enumeration|component|distinct/); assert.deepEqual(editedModelBytes(dataStore, view), before); }
  const input = proposal(storey, [analysis('Unsupported schema')]);
  dataStore.schemaVersion = 'IFC2X3'; assert.throws(() => prepareStructuralReview(useViewerStore, input), /schema|differs/);
});
test('#7318 first native read keeps live view/editor/history maps absent until explicit Apply', async () => {
  const { dataStore, view, storey } = await setup();
  const emptyViews = new Map<string, typeof view>(), editors = useViewerStore.getState().storeEditors, history = useViewerStore.getState().undoStacks;
  useViewerStore.setState({ mutationViews: emptyViews });
  const review = prepareStructuralReview(useViewerStore, proposal(storey, [analysis('First read supplied owner')]));
  assert.equal(useViewerStore.getState().mutationViews, emptyViews); assert.equal(emptyViews.size, 0);
  assert.equal(useViewerStore.getState().storeEditors, editors); assert.equal(editors.size, 0); assert.equal(useViewerStore.getState().undoStacks, history);
  commitReviewedStructural(useViewerStore, review, 'first-read explicit Apply');
  const graph = extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!)));
  assert.equal(graph.analysisModels[0].name, 'First read supplied owner');
});
test('#7318 federation binds native graph creation/history solely to the explicitly supplied second source', async () => {
  const { dataStore, view, storey } = await setup(), second = await parseIfc(editedModelBytes(dataStore, view));
  const primary = useViewerStore.getState().models.get(SAMPLE_MODEL)!, id = 'second-structural-source';
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, primary], [id, { ...primary, id, name: id, idOffset: 1000000, ifcDataStore: second }]]) });
  const before = editedModelBytes(dataStore, view), receipt = commitReviewedStructural(useViewerStore, prepareStructuralReview(useViewerStore, proposal(storey, [analysis('Secondary supplied owner')], id)), 'federated explicit Apply');
  assert.equal(receipt.batches[0].modelId, id);
  assert.equal(extractStructuralOnDemand(await parseIfc(editedModelBytes(second, useViewerStore.getState().mutationViews.get(id)!))).analysisModels[0].name, 'Secondary supplied owner');
  assert.deepEqual(editedModelBytes(dataStore, view), before); assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, undefined);
});
test('#7318 invalid current Root identity and effective geometry-unit declaration changes refuse binding without invented identities or units', async () => {
  const { dataStore, view, storey } = await setup();
  const made = commitReviewedStructural(useViewerStore, prepareStructuralReview(useViewerStore, proposal(storey, [{ op: 'structural.group.create', params: { Name: 'Supplied existing group', ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G' } }])), 'existing group');
  const id = made.applied[0].expressId!;
  view.setAttribute(id, 'GlobalId', 'invalid-guid', true);
  assert.equal(extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view))).loadGroups[0].globalId, 'invalid-guid', 'actual STEP preserves the malformed native identity before admission refusal');
  assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [{ op: 'structural.group.assign', target: id, related: [storey] }])), /identity|GlobalId/);
  const units = readStructuralSnapshot(readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!, [storey]).records;
  const lengthUnit = units.find(row => row.type === 'IfcSIUnit' && String(row.attributes[1]).replaceAll('.', '') === 'LENGTHUNIT');
  assert.ok(lengthUnit);
  view.setAttribute(lengthUnit.expressId, 'Prefix', '$', true);
  assert.throws(() => prepareStructuralReview(useViewerStore, proposal(storey, [{ op: 'structural.member.create', storey, params: { Name: 'No native unit guess', Start: [0, 0, 0], End: [4, 0, 0] } }])), /unit|scale/);
});
