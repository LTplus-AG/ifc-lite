/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { RelationshipType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { addGroupToStore, readGroupInStore, readGroupEvidenceInStore } from '@ifc-lite/create';
import { asSourceBytes } from '@ifc-lite/parser';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { useViewerStore } from '@/store';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { parseGroupProposal, type GroupOperation } from './group-lifecycle-proposal';
import { prepareGroupReview } from './group-lifecycle-review';
import { commitReviewedGroup } from './group-lifecycle-receipt';
import { decodeModelChangeReceipt } from './receipts';
import { undoModelChanges } from './model-change-commit';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
async function setup() {
  const fixture = await seedAuthoringSample();
  const member = { expressId: 291, GlobalId: fixture.dataStore.entities.getGlobalId(291)! };
  const context = { store: fixture.dataStore, mutationView: fixture.view, ownerHistoryId: null };
  return { ...fixture, member, context };
}
async function unchangedExports(actual: Uint8Array[], expected: Uint8Array[]) {
  assert.equal(actual.length, expected.length);
  await Promise.all(actual.map((bytes, index) => assertSameNativeIfcGraph(bytes, expected[index])));
}
function proposal(selected: number[], operations: GroupOperation[]) {
  const target = readOnlyModelEditTarget(useViewerStore.getState(), SAMPLE_MODEL)!;
  const expected = readGroupEvidenceInStore({ store: target.dataStore, mutationView: target.view, ownerHistoryId: null }, selected);
  return parseGroupProposal(JSON.stringify({ version: 1, kind: 'group.lifecycle', title: 'Review current groups', modelId: SAMPLE_MODEL, expected, operations }));
}
test('#7329 public viewer Group adapter records creation, replacement and deletion as separate compound Undo steps', async () => {
  const { dataStore, view, member, context } = await setup(), adapter = createStoreAdapter(useViewerStore);
  assert.ok(adapter.addGroup); assert.ok(adapter.updateGroup); assert.ok(adapter.removeGroup); assert.ok(adapter.readGroup);
  const group = adapter.addGroup(SAMPLE_MODEL, { Name: 'Public group', RelatedObjects: [{ ...member, modelId: SAMPLE_MODEL }] });
  const created = adapter.readGroup(group), relation = created.memberships[0].relationship;
  adapter.updateGroup(created, { Name: 'Public changed', RelatedObjects: [] });
  assert.equal(adapter.readGroup(group).memberships.length, 0);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.deepEqual(adapter.readGroup(group), created, 'one Undo restores the original name and the forgotten overlay relationship');
  useViewerStore.getState().redo(SAMPLE_MODEL);
  adapter.removeGroup(adapter.readGroup(group));
  assert.throws(() => readGroupInStore(context, group), /live valid/);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(adapter.readGroup(group).Name, 'Public changed');
  assert.equal(adapter.readGroup(group).memberships.length, 0);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(adapter.readGroup(group).memberships[0].relationship.GlobalId, relation.GlobalId);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.entityIndex.byId.has(group.expressId), false);
  assert.equal(saved.entityIndex.byId.has(relation.expressId), false);
  assert.equal(saved.entities.getGlobalId(member.expressId), member.GlobalId);
});
test('#7329 reviewed replacement preserves group and relation identities through independent IFC export and one receipt Undo', async () => {
  const { dataStore, view, member, context } = await setup();
  const group = addGroupToStore(context, { Name: 'Before review', RelatedObjects: [member] });
  const old = readGroupInStore(context, group), before = editedModelBytes(dataStore, view), held = view.prepareAtomic(() => null);
  const review = prepareGroupReview(useViewerStore, proposal([group.expressId], [{ op: 'group.update', target: group, params: { Name: 'After review', RelatedObjects: [member] } }]));
  held.validate(); await unchangedExports([editedModelBytes(dataStore, view)], [before]);
  const receipt = commitReviewedGroup(useViewerStore, review, 'native group acceptance');
  assert.ok(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt))));
  const bytes = editedModelBytes(dataStore, view), saved = await parseIfc(bytes);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  assert.equal(saved.entities.getName(group.expressId), 'After review');
  assert.equal(saved.entities.getGlobalId(group.expressId), group.GlobalId);
  assert.equal(saved.getEntity(old.memberships[0].relationship.expressId)?.attributes[0], old.memberships[0].relationship.GlobalId);
  assert.deepEqual(saved.relationships.getRelated(group.expressId, RelationshipType.AssignsToGroup, 'forward'), [member.expressId]);
  assert.equal(undoModelChanges(useViewerStore, receipt).ok, true);
  assert.deepEqual(readGroupInStore(context, group), old);
  assert.throws(() => review.commit(), /already applied/);
});
test('#7329 reviewed deletion rewrites incoming shared membership, keeps other members and supports one complete Undo', async () => {
  const { dataStore, view, member, context } = await setup();
  const group = addGroupToStore(context, { Name: 'Remove group', RelatedObjects: [member] });
  const parent = addGroupToStore(context, { Name: 'Keep group', RelatedObjects: [group, member] });
  const before = readGroupInStore(context, parent), old = readGroupInStore(context, group);
  const receipt = commitReviewedGroup(useViewerStore, prepareGroupReview(useViewerStore, proposal([group.expressId], [{ op: 'group.remove', target: group }])), 'shared removal');
  const bytes = editedModelBytes(dataStore, view), saved = await parseIfc(bytes);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  assert.equal(saved.entityIndex.byId.has(group.expressId), false);
  assert.equal(saved.entityIndex.byId.has(old.memberships[0].relationship.expressId), false);
  assert.equal(saved.entities.getGlobalId(member.expressId), member.GlobalId);
  assert.deepEqual(saved.relationships.getRelated(parent.expressId, RelationshipType.AssignsToGroup, 'forward'), [member.expressId]);
  assert.equal(saved.getEntity(before.memberships[0].relationship.expressId)?.attributes[0], before.memberships[0].relationship.GlobalId);
  assert.equal(undoModelChanges(useViewerStore, receipt).ok, true);
  assert.deepEqual(readGroupInStore(context, group), old); assert.deepEqual(readGroupInStore(context, parent), before);
});
test('#7329 changed source, selected approvals, current metadata, native graph or edit permission refuse without publishing', async () => {
  const { dataStore, view, member } = await setup();
  const create: GroupOperation = { op: 'group.create', params: { Name: 'Must remain uncreated', RelatedObjects: [member] } };
  let review = prepareGroupReview(useViewerStore, proposal([member.expressId], [create]));
  view.setAttribute(member.expressId, 'Description', 'Unjournalled source change');
  let before = editedModelBytes(dataStore, view);
  assert.throws(() => review.commit(), /changed/); await unchangedExports([editedModelBytes(dataStore, view)], [before]);
  review = prepareGroupReview(useViewerStore, proposal([member.expressId], [create]));
  review.delta[0].after!.attributes[2] = 'Changed preview';
  assert.throws(() => review.commit(), /review changed/); await unchangedExports([editedModelBytes(dataStore, view)], [before]);
  review = prepareGroupReview(useViewerStore, proposal([member.expressId], [create]));
  useViewerStore.setState({ editEnabled: false }); assert.throws(() => review.commit(), /Edit|read.only/i);
  useViewerStore.setState({ editEnabled: true });
  review = prepareGroupReview(useViewerStore, proposal([member.expressId], [create]));
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model }]]) });
  assert.throws(() => review.commit(), /source population changed/);
  before = editedModelBytes(dataStore, view);
  const current = proposal([member.expressId], [create]);
  current.expected.members[0].GlobalId = '0000000000000000000000';
  assert.throws(() => prepareGroupReview(useViewerStore, current), /differs/);
  await unchangedExports([editedModelBytes(dataStore, view)], [before]);
  dataStore.source = asSourceBytes(new Uint8Array());
  assert.throws(() => prepareGroupReview(useViewerStore, current), /source/);
});

test('#7329 two real loaded sources keep identical local IDs source-owned, reject foreign membership and stale peer evidence, and Undo each graph once', async () => {
  const { dataStore, view, member } = await setup(), peerId = 'peer';
  const peerStore = await parseIfc(editedModelBytes(dataStore, view));
  const peerView = new MutablePropertyView(peerStore.properties || null, peerId);
  const ownModel = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({
    models: new Map([[SAMPLE_MODEL, ownModel], [peerId, { ...ownModel, id: peerId, idOffset: 1_000_000, ifcDataStore: peerStore }]]),
    mutationViews: new Map([[SAMPLE_MODEL, view], [peerId, peerView]]),
  });
  const adapter = createStoreAdapter(useViewerStore);
  assert.ok(adapter.addGroup); assert.ok(adapter.readGroup); assert.ok(adapter.updateGroup);
  const local = { ...member, modelId: SAMPLE_MODEL }, foreign = { ...member, modelId: peerId };
  const own = adapter.addGroup(SAMPLE_MODEL, { Name: 'First source group', RelatedObjects: [local] });
  const peer = adapter.addGroup(peerId, { Name: 'Second source group', RelatedObjects: [foreign] });
  const firstSaved = await parseIfc(editedModelBytes(dataStore, view));
  const secondSaved = await parseIfc(editedModelBytes(peerStore, peerView));
  assert.equal(firstSaved.entities.getName(own.expressId), 'First source group');
  assert.equal(secondSaved.entities.getName(peer.expressId), 'Second source group');
  assert.deepEqual(firstSaved.relationships.getRelated(own.expressId, RelationshipType.AssignsToGroup, 'forward'), [member.expressId]);
  assert.deepEqual(secondSaved.relationships.getRelated(peer.expressId, RelationshipType.AssignsToGroup, 'forward'), [member.expressId]);
  assert.notEqual(own.GlobalId, peer.GlobalId, 'independent native groups have independent Root ownership');
  const before = [editedModelBytes(dataStore, view), editedModelBytes(peerStore, peerView)];
  assert.throws(() => adapter.updateGroup!(adapter.readGroup!(own), { RelatedObjects: [foreign] }), /another source/);
  await unchangedExports([editedModelBytes(dataStore, view), editedModelBytes(peerStore, peerView)], before);
  const review = prepareGroupReview(useViewerStore, proposal([member.expressId], [{ op: 'group.create', params: { Name: 'Stale draft', RelatedObjects: [member] } }]));
  peerView.setAttribute(member.expressId, 'Description', 'Peer changed after review');
  const changed = [editedModelBytes(dataStore, view), editedModelBytes(peerStore, peerView)];
  assert.throws(() => review.commit(), /source population changed/);
  await unchangedExports([editedModelBytes(dataStore, view), editedModelBytes(peerStore, peerView)], changed);
  useViewerStore.getState().undo(peerId);
  const peerBytes = editedModelBytes(peerStore, peerView), undonePeer = await parseIfc(peerBytes);
  assert.equal(undonePeer.entityIndex.byId.has(peer.expressId), false);
  assert.equal(undonePeer.entities.getGlobalId(member.expressId), member.GlobalId);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(peerBytes)), []);
  assert.equal(adapter.readGroup(own).Name, 'First source group', 'peer Undo preserves the other native graph');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const ownBytes = editedModelBytes(dataStore, view), undoneOwn = await parseIfc(ownBytes);
  assert.equal(undoneOwn.entityIndex.byId.has(own.expressId), false);
  assert.equal(undoneOwn.entities.getGlobalId(member.expressId), member.GlobalId);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(ownBytes)), []);
});
