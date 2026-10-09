/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createStructuralStoreBackend } from '@ifc-lite/sdk';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { resolveSpatialAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseStructuralProposal } from './structural-graph-proposal';
import { prepareStructuralReview } from './structural-graph-review';
import { readStructuralSnapshot } from './structural-graph-evidence';
import { readOnlyModelEditTarget } from './model-authoring-read-target';

// Campaign6812 finite audit: supplied analytical geometry, restraint booleans
// and literal load components are test inputs, never inferred engineering design.
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
async function nativeGraph() {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  assert.equal(resolveSpatialAnchor(dataStore, storey).lengthUnitScale, .001);
  const before = extractStructuralOnDemand(dataStore, view);
  const made = recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, editor) => {
    const write = createStructuralStoreBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, editor, mutationView: editor.getMutationView(), ownerHistoryId: null }));
    const group = write.addStructuralLoadGroup(SAMPLE_MODEL, { Name: 'Supplied audit loads', ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', PredefinedType: 'LOAD_GROUP' });
    const analysis = write.addStructuralAnalysisModel(SAMPLE_MODEL, { Name: 'Supplied audit analytical graph', PredefinedType: 'LOADING_3D', LoadGroupIds: [group.expressId] });
    const member = write.addStructuralCurveMember(SAMPLE_MODEL, storey, { Name: 'Supplied straight member', Start: [0, 0, 0], End: [4, 0, 0], PredefinedType: 'RIGID_JOINED_MEMBER' });
    const connection = write.addStructuralPointConnection(SAMPLE_MODEL, storey, { Name: 'Supplied point restraint', Position: [4, 0, 0], BoundaryCondition: { Name: 'Supplied pinned restraint', TranslationalStiffnessX: true, TranslationalStiffnessY: true, TranslationalStiffnessZ: true, RotationalStiffnessX: false, RotationalStiffnessY: false, RotationalStiffnessZ: false } });
    const point = write.addStructuralPointAction(SAMPLE_MODEL, { Name: 'Supplied point component', GlobalOrLocal: 'GLOBAL_COORDS', ForceZ: -1000, ForceX: 0 });
    const linear = write.addStructuralLinearAction(SAMPLE_MODEL, { Name: 'Supplied linear component', GlobalOrLocal: 'LOCAL_COORDS', LinearForceZ: -200, LinearMomentX: 0 });
    write.connectStructuralMemberToConnection(SAMPLE_MODEL, member.expressId, connection.expressId);
    write.connectStructuralActivityToItem(SAMPLE_MODEL, connection.expressId, point.expressId);
    write.connectStructuralActivityToItem(SAMPLE_MODEL, member.expressId, linear.expressId);
    write.assignToStructuralGroup(SAMPLE_MODEL, analysis.expressId, [member.expressId, connection.expressId]);
    write.assignToStructuralGroup(SAMPLE_MODEL, group.expressId, [point.expressId, linear.expressId]);
    return { analysis, member, connection, point, linear, group };
  }, 'supplied-structural-audit');
  const bytes = editedModelBytes(dataStore, view), text = new TextDecoder().decode(bytes);
  assert.deepEqual(danglingReferences(text), []);
  const reparsed = await parseIfc(bytes), graph = extractStructuralOnDemand(reparsed);
  const analysis = graph.analysisModels.find(row => row.name === 'Supplied audit analytical graph')!;
  const member = graph.members.find(row => row.name === 'Supplied straight member')!;
  const connection = graph.connections.find(row => row.name === 'Supplied point restraint')!;
  const group = graph.loadGroups.find(row => row.name === 'Supplied audit loads')!;
  const point = graph.activities.find(row => row.name === 'Supplied point component')!;
  const linear = graph.activities.find(row => row.name === 'Supplied linear component')!;
  assert.ok(analysis && member && connection && group && point && linear, 'independent IFC parser reads every supplied native graph owner');
  assert.deepEqual(analysis.itemGlobalIds.sort(), [member.globalId, connection.globalId].sort());
  assert.deepEqual(analysis.loadGroupGlobalIds, [group.globalId]);
  assert.deepEqual(member.connectionGlobalIds, [connection.globalId]);
  assert.deepEqual(connection.memberGlobalIds, [member.globalId]);
  assert.equal(connection.appliedCondition?.components.TranslationalStiffnessX, true);
  assert.equal(connection.appliedCondition?.components.RotationalStiffnessX, false);
  assert.equal(point.appliedLoad?.components.ForceZ, -1000);
  assert.equal(point.appliedLoad?.components.ForceX, 0);
  assert.equal(linear.appliedLoad?.components.LinearForceZ, -200);
  assert.equal(linear.appliedLoad?.components.LinearMomentX, 0);
  assert.equal(point.appliesToGlobalId, connection.globalId);
  assert.equal(linear.appliesToGlobalId, member.globalId);
  assert.deepEqual(group.activityGlobalIds.sort(), [point.globalId, linear.globalId].sort());
  assert.ok([...reparsed.entityIndex.byId.keys()].some(id => { const record = reparsed.getEntity(id); return record?.type === 'IFCCARTESIANPOINT' && JSON.stringify(record.attributes[0]) === JSON.stringify([4000, 0, 0]); }), 'independently parsed native endpoint preserves canonical SI-to-millimetre conversion');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(extractStructuralOnDemand(dataStore, view).members.length, before.members.length);
  assert.equal(extractStructuralOnDemand(dataStore, view).activities.length, before.activities.length);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.equal(extractStructuralOnDemand(dataStore, view).members.length, before.members.length + 1);
  assert.equal(extractStructuralOnDemand(dataStore, view).activities.length, before.activities.length + 2);
  return made;
}
test('Campaign6812 supplied native Structural graph factory survives independent IFC reparse and grouped Undo/Redo', async () => { await nativeGraph(); });
test('Campaign6812 existing supplied native StructuralAnalysisModel should admit a reviewed proposal after the full native control', async () => {
  await nativeGraph();
  const state = useViewerStore.getState(), target = readOnlyModelEditTarget(state, SAMPLE_MODEL)!;
  const expected = readStructuralSnapshot(target, [dataStoreStorey(target.dataStore)]);
  const proposal = parseStructuralProposal(JSON.stringify({ version: 1, kind: 'structural.graph', title: 'Supplied analytical graph', modelId: SAMPLE_MODEL, nativeMeasuresAcknowledged: true, expected, operations: [{ op: 'structural.analysis.create', ref: 'analysis', params: { Name: 'Reviewed supplied analytical graph', PredefinedType: 'LOADING_3D' } }] }));
  const bytes = editedModelBytes(target.dataStore, target.view), history = state.undoStacks.get(SAMPLE_MODEL)?.length;
  const review = prepareStructuralReview(useViewerStore, proposal);
  assert.ok(review.delta.some(row => row.after?.type === 'IfcStructuralAnalysisModel'));
  assert.deepEqual(editedModelBytes(target.dataStore, target.view), bytes);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, history);
  review.commit();
  assert.ok(extractStructuralOnDemand(await parseIfc(editedModelBytes(target.dataStore, useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!))).analysisModels.some(row => row.name === 'Reviewed supplied analytical graph'));
});
function dataStoreStorey(store: Parameters<typeof extractStructuralOnDemand>[0]) { return store.entities.getExpressIdByGlobalId(GROUND_STOREY)!; }
test('Campaign6812 canonical Structural refusals preserve source and grouped history', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  const before = editedModelBytes(dataStore, view), history = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length;
  for (const invalid of ['empty-load', 'zero-length', 'empty-membership', 'user-defined-without-type']) {
    assert.throws(() => recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, editor) => {
      const write = createStructuralStoreBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, editor, mutationView: editor.getMutationView(), ownerHistoryId: null }));
      if (invalid === 'empty-load') return write.addStructuralPointAction(SAMPLE_MODEL, { Name: 'No supplied component' });
      if (invalid === 'zero-length') return write.addStructuralCurveMember(SAMPLE_MODEL, storey, { Start: [1, 1, 1], End: [1, 1, 1] });
      if (invalid === 'empty-membership') return write.assignToStructuralGroup(SAMPLE_MODEL, storey, []);
      return write.addStructuralAnalysisModel(SAMPLE_MODEL, { PredefinedType: 'USERDEFINED' });
    }, 'supplied-invalid-structural'), /component|distinct|non-empty|ObjectType/);
    assert.deepEqual(editedModelBytes(dataStore, view), before);
    assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, history);
  }
});
