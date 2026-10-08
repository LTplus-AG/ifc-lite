/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896 (P11): drafts keep exact finding membership through edits and
// reconcile against a newer real clash run only by explicit proposal.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManualClashGroups, type ManualClashGroup } from '../clash/manual-groups';
import { groupOf, proxyWallRun, sampleElements, PROXY_WALL_RULE } from '@/test/bcf-draft-fixture';
import { decodeDraftBatch } from './draft-codec';
import { draftBatchFromGroups, draftBatchFromSelection, findingFromClash } from './draft-create';
import { mergeDraftTopics, removeDraftMember, splitDraftTopic, editDraftTopic } from './draft-edit';
import { applyTopicReconciliation, reconcileDraftBatch } from './draft-reconcile';
import { findingIdentity, type DraftBatch } from './draft-types';

const RULES = [PROXY_WALL_RULE.id];
const claims = (batch: DraftBatch) => batch.topics.flatMap(topic => topic.members.map(findingIdentity));

async function drafted() {
  const { proxies, walls } = await sampleElements();
  const clashes = await proxyWallRun([[0, 1], [1], [2], []]);
  const groups = [groupOf('g-riser', 'Riser through core walls', clashes, [proxies[0].key, proxies[1].key]),
    groupOf('g-east', 'East wall penetration', clashes, [proxies[2].key])];
  const batch = await draftBatchFromGroups('Coordination round 1', 'ws-1', resolveManualClashGroups(groups, clashes),
    { clashes, rules: RULES });
  return { proxies, walls, clashes, groups, batch };
}

test('reviewed groups become one topic each with exact members, bridge viewpoints and no assignee', async () => {
  const { batch, clashes, proxies, walls } = await drafted();
  assert.equal(clashes.length, 4, 'the real engine finds proxy0×wall0, proxy0×wall1, proxy1×wall1, proxy2×wall2');
  assert.deepEqual(batch.topics.map(topic => [topic.title, topic.members.length]), [['Riser through core walls', 3], ['East wall penetration', 1]]);
  assert.equal(new Set(claims(batch)).size, 4, 'every finding claimed exactly once');
  const [riser] = batch.topics;
  assert.equal(riser.assignedTo, undefined, 'assignees stay empty until mapped to a server user');
  assert.equal(riser.topicType, 'Clash');
  const selected = new Set(riser.viewpoint?.components?.selection?.map(component => component.ifcGuid));
  assert.deepEqual(selected, new Set([proxies[0].key, proxies[1].key, walls[0].key, walls[1].key]));
  assert.equal(riser.viewpoint?.components?.coloring?.length, 2, 'A/B colouring from the clash bridge');
  assert.ok(riser.viewpoint?.perspectiveCamera, 'framed camera');
  assert.equal(decodeDraftBatch(JSON.parse(JSON.stringify(batch)))?.topics[0].viewpoint?.guid, riser.viewpoint?.guid,
    'the stored viewpoint is already in its portable form');
  assert.equal(batch.source.findingCount, 4);
});

test('split, merge and member removal keep a partition, the original GUID and re-framed viewpoints', async () => {
  const { batch, proxies } = await drafted();
  const riser = batch.topics[0];
  const moved = new Set(riser.members.filter(member => member.a.key === proxies[1].key || member.b.key === proxies[1].key).map(findingIdentity));
  const split = await splitDraftTopic(batch, riser.guid, moved, 'Proxy 2 at core');
  assert.ok(split.ok);
  assert.deepEqual(split.batch.topics.map(topic => topic.members.length), [2, 1, 1]);
  assert.equal(split.batch.topics[0].guid, riser.guid, 'the original keeps its identity');
  assert.notEqual(split.batch.topics[1].viewpoint?.guid, riser.viewpoint?.guid);
  assert.deepEqual(new Set(claims(split.batch)), new Set(claims(batch)), 'no finding lost or duplicated');
  assert.deepEqual(await splitDraftTopic(batch, riser.guid, new Set(riser.members.map(findingIdentity))), { ok: false, reason: 'empty-split' });

  const merged = await mergeDraftTopics(split.batch, [split.batch.topics[0].guid, split.batch.topics[1].guid]);
  assert.ok(merged.ok);
  assert.equal(merged.batch.topics.length, 2);
  assert.equal(merged.batch.topics[0].guid, riser.guid);
  assert.deepEqual(new Set(claims(merged.batch)), new Set(claims(batch)));

  const removed = await removeDraftMember(merged.batch, riser.guid, findingIdentity(merged.batch.topics[0].members[0]));
  assert.ok(removed.ok);
  assert.equal(removed.batch.topics[0].members.length, 2);
  const renamed = editDraftTopic(removed.batch, riser.guid, { title: 'Riser (reviewed)', assignedTo: '' });
  assert.ok(renamed.ok);
  assert.equal(renamed.batch.topics[0].title, 'Riser (reviewed)');
  assert.equal(renamed.batch.topics[0].assignedTo, undefined);
});

test('the durable decoder refuses a batch in which two topics claim one finding', async () => {
  const { batch } = await drafted();
  const duplicated = { ...batch, topics: [batch.topics[0], { ...batch.topics[1], members: [...batch.topics[1].members, batch.topics[0].members[0]] }] };
  assert.equal(decodeDraftBatch(JSON.parse(JSON.stringify(duplicated))), null);
  assert.equal(decodeDraftBatch(JSON.parse(JSON.stringify({ ...batch, topics: [batch.topics[0], batch.topics[0]] }))), null);
});

test('a newer run yields an explicit proposal: vanished, new group match, claimed elsewhere, unchanged across a model reload', async () => {
  const { batch, groups, proxies } = await drafted();
  // The coordinator also drafts proxy 4 on its own, then a newer run moves proxy 1 away and proxy 4 into wall 3.
  const newer = await proxyWallRun([[0, 1], [], [2], [3]], 'architecture-reloaded');
  const selectionTopic = (await draftBatchFromSelection('x', 'Proxy 4', newer.filter(clash => clash.a.key === proxies[3].key), { clashes: newer, rules: RULES })).topics[0];
  const withSelection = { ...batch, topics: [...batch.topics, selectionTopic] };
  // After drafting, the workspace group gained proxy 4's finding (claimed by the selection topic) and proxy 3's.
  const riserGroup: ManualClashGroup = { ...groups[0], members: [...groups[0].members,
    ...groupOf('tmp', 'tmp', newer, [proxies[3].key]).members] };
  const proposal = reconcileDraftBatch(withSelection, { clashes: newer, rules: RULES,
    groupsOf: workspace => workspace === 'ws-1' ? [riserGroup, groups[1]] : undefined });
  assert.equal(proposal.sameRun, false);
  const riser = proposal.topics[0];
  assert.equal(riser.unchanged.length, 2, 'proxy 1 still crosses walls 1 and 2 although every model id changed');
  assert.ok(riser.unchanged.every(member => member.occurrenceKey.includes('architecture-reloaded')), 'snapshots refreshed from the newer run');
  assert.deepEqual(riser.disappeared.map(member => member.a.key === proxies[1].key || member.b.key === proxies[1].key), [true]);
  assert.deepEqual(riser.added, [], 'a match held by another topic is never moved');
  assert.equal(riser.claimedElsewhere.length, 1);
  assert.equal(riser.claimedElsewhere[0].topicGuid, selectionTopic.guid);
  assert.equal(proposal.topics[1].disappeared.length + proposal.topics[1].added.length, 0, 'unchanged topic has nothing to apply');

  const applied = await applyTopicReconciliation(withSelection, riser);
  assert.ok(applied);
  assert.equal(applied.topics[0].members.length, 2);
  assert.deepEqual(applied.topics.slice(1), withSelection.topics.slice(1), 'other topics untouched until their own proposal is applied');
  assert.equal(withSelection.topics[0].members.length, 3, 'the proposal alone changes nothing');
});

test('new group matches become placeable additions, or unplaced when the group backs several split topics', async () => {
  const { batch, groups, proxies, clashes } = await drafted();
  const newer = await proxyWallRun([[0, 1], [1], [2], [3]]);
  const grown: ManualClashGroup = { ...groups[1], members: [...groups[1].members, ...groupOf('t', 't', newer, [proxies[3].key]).members] };
  const groupsOf = () => [groups[0], grown];
  const single = reconcileDraftBatch(batch, { clashes: newer, rules: RULES, groupsOf });
  assert.equal(single.topics[1].added.length, 1, 'the east group gained proxy 4 × wall 4');
  const riser = batch.topics[0];
  const split = await splitDraftTopic(batch, riser.guid, new Set([findingIdentity(findingFromClash(clashes[0]))]));
  assert.ok(split.ok);
  const riserGrown: ManualClashGroup = { ...groups[0], members: [...groups[0].members, ...groupOf('t', 't', newer, [proxies[3].key]).members] };
  const shared = reconcileDraftBatch(split.batch, { clashes: newer, rules: RULES, groupsOf: () => [riserGrown, groups[1]] });
  assert.equal(shared.unplaced.length, 1, 'placement after a split is the coordinator’s call');
  assert.ok(shared.topics.every(topic => topic.added.length === 0));
});
