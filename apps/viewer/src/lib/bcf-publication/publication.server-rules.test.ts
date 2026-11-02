/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Publishing to BCF servers that keep less than they accept (buildagil's
// openCDE API, measured 2026-11-02): a status nulled for a type without one,
// a fixed topic-type list, and a topic list that ignores `$skip`. Every
// request goes to the loopback peer over real HTTP.

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_BCF_PROJECT } from '@/test/bcf-http-server';
import { connectPeer, entriesOf, publish, reviewedBatch } from '@/test/bcf-publication-fixture';
import { bcfServerProfile } from '@/services/bcf-server-profiles';
import { editDraftTopic } from '../bcf-drafts/draft-edit';
import { checkEntry } from './outbox-check';
import { publishDraftBatch } from './outbox-publish';
import { readPublication } from './outbox-store';

const buildagil = bcfServerProfile('https://openapi.buildagil.com');

test('a status the server silently drops is not a remote conflict on the next update', async t => {
  // Any server: the baseline is what the create's response says was stored.
  const peer = await connectPeer(t, { statusOnlyForTypes: ['Issue'] });
  const batch = await reviewedBatch();
  const first = await publish(batch, peer);
  const remoteGuid = entriesOf(first.record, 'createTopic')[0].receipt?.remoteGuid ?? '';
  assert.equal(peer.state.topics.get(remoteGuid)?.topic.topic_status, null, 'the peer nulled the Clash topic status');

  const edited = editDraftTopic(batch, batch.topics[0].guid, { title: 'Riser (resized sleeves)' });
  assert.ok(edited.ok);
  const second = await publish(edited.batch, peer);
  assert.deepEqual(second.report.blocked, [], 'no false conflict from the dropped status');
  assert.deepEqual(second.report.receipts.map(receipt => receipt.operation), ['updateTopic']);
  assert.equal(peer.state.topics.get(remoteGuid)?.topic.title, 'Riser (resized sleeves)');

  const again = editDraftTopic(edited.batch, batch.topics[0].guid, { title: 'Riser (sleeves ordered)' });
  assert.ok(again.ok);
  const third = await publish(again.batch, peer);
  assert.deepEqual(third.report.receipts.map(receipt => receipt.operation), ['updateTopic'], 'an update\'s response is the next baseline too');
});

test('with a status-dropping server, a real remote edit still blocks the update', async t => {
  const peer = await connectPeer(t, { statusOnlyForTypes: ['Issue'] });
  const batch = await reviewedBatch();
  const first = await publish(batch, peer);
  const remoteGuid = entriesOf(first.record, 'createTopic')[0].receipt?.remoteGuid ?? '';
  await peer.connection.client.updateTopic(LOCAL_BCF_PROJECT, remoteGuid, { title: 'Renamed by the architect', topic_type: 'Clash' });
  const writes = peer.state.receivedWrites;
  const edited = editDraftTopic(batch, batch.topics[0].guid, { title: 'Riser (resized sleeves)' });
  assert.ok(edited.ok);
  const second = await publish(edited.batch, peer);
  assert.equal(second.report.blocked.length, 1);
  assert.equal(peer.state.receivedWrites, writes, 'no PUT over the human edit');
  assert.equal(peer.state.topics.get(remoteGuid)?.topic.title, 'Renamed by the architect');
});

test('checking an uncertain create on a server that ignores $skip pages by modified_date and finds it', async t => {
  const peer = await connectPeer(t, { ignoreSkip: true });
  // 250 older topics by others, three per second, so a tie straddles the 200-topic page boundary.
  for (let index = 0; index < 250; index++) {
    const guid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const date = new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 3) * 1000).toISOString().replace('.000Z', 'Z');
    peer.state.topics.set(guid, { topic: { guid, title: `Existing ${index}`, creation_author: 'architect@example.test',
      creation_date: date, modified_date: date }, comments: [], viewpoints: [] });
  }
  const batch = await reviewedBatch();
  peer.state.loseNextWriteResponse = true;
  const first = await publish(batch, peer);
  const lost = entriesOf(first.record, 'createTopic')[0];
  assert.equal(lost.state, 'uncertain');
  const writes = peer.state.receivedWrites;

  // Offset paging sees the same first page again: the create cannot be proven absent, so it is not requeueable.
  const bySkip = await checkEntry(first.record.id, lost.id, { ...peer.connection, rules: {} });
  assert.ok(bySkip.ok);
  assert.equal(bySkip.check.result, 'unavailable');

  assert.equal(buildagil?.topicPaging, 'modified-date');
  const byDate = await checkEntry(first.record.id, lost.id, { ...peer.connection, rules: buildagil });
  assert.ok(byDate.ok);
  assert.equal(byDate.check.result, 'committed');
  const created = [...peer.state.topics.values()].filter(item => item.topic.creation_author !== 'architect@example.test');
  assert.ok(created.some(item => item.topic.guid === byDate.check.candidates[0].guid));
  assert.equal(peer.state.receivedWrites, writes, 'the check only reads');
});

const BUILDAGIL_TYPES = ['Task', 'Model Issue', 'Documentation Log', 'Incident Log', 'Deficiency Log', 'Topic', 'Information', 'Decision'];
/** A peer with buildagil's measured topic vocabulary and status rule. */
const buildagilLike = { topicTypes: BUILDAGIL_TYPES, topicStatuses: ['Draft', 'Open', 'Closed'],
  statusOnlyForTypes: ['Task', 'Model Issue', 'Documentation Log', 'Incident Log', 'Deficiency Log'] };

test('a draft type the server lacks is refused before sending, then published as the chosen server type', async t => {
  const peer = await connectPeer(t, buildagilLike);
  const connection = { ...peer.connection, rules: buildagil };
  const batch = await reviewedBatch();
  const refused = await publishDraftBatch(batch, peer.target, connection);
  assert.equal(refused?.report.stopped, 'preflight');
  assert.deepEqual(refused?.report.preflight?.issues.map(issue => [issue.field, issue.value]), [['topic_type', 'Clash'], ['topic_type', 'Clash']]);
  assert.deepEqual(refused?.report.preflight?.issues[0].allowed, BUILDAGIL_TYPES);
  assert.equal(peer.state.receivedWrites, 0);

  const published = await publishDraftBatch(batch, peer.target, connection, { topicTypes: { Clash: 'Model Issue' } });
  assert.equal(published?.report.preflight?.ok, true);
  assert.deepEqual(published?.report.preflight?.warnings.filter(warning => warning.kind === 'withheld'), [], 'Model Issue keeps its status');
  const topics = [...peer.state.topics.values()].map(item => item.topic);
  assert.equal(topics.length, 2);
  assert.ok(topics.every(topic => topic.topic_type === 'Model Issue' && topic.topic_status === 'Open'));

  // A later plan without a choice (a reopened panel) keeps the type already published: nothing is retyped,
  // nothing is refused, nothing is left queued (#8656 review).
  const writes = peer.state.receivedWrites;
  const reopened = await publishDraftBatch(batch, peer.target, connection);
  assert.equal(reopened?.report.preflight?.ok, true, 'no picker again for published drafts');
  assert.equal(reopened?.report.sent, 0);
  assert.equal(peer.state.receivedWrites, writes);
  const stored = (await readPublication(reopened?.plan.record.id ?? ''))?.record;
  assert.deepEqual(stored?.entries.filter(entry => entry.state !== 'done'), [], 'no unsent update left behind');

  // A fresh choice still wins, and retypes the published topics explicitly.
  const retyped = await publishDraftBatch(batch, peer.target, connection, { topicTypes: { Clash: 'Task' } });
  assert.deepEqual(retyped?.report.receipts.map(receipt => receipt.operation), ['updateTopic', 'updateTopic']);
  assert.ok([...peer.state.topics.values()].every(item => item.topic.topic_type === 'Task'));
});

test('a chosen type is remembered for new drafts of the same type and survives a reopened panel (#8656 review)', async t => {
  const peer = await connectPeer(t, buildagilLike);
  const connection = { ...peer.connection, rules: buildagil };
  const batch = await reviewedBatch();
  const published = await publishDraftBatch(batch, peer.target, connection, { topicTypes: { Clash: 'Information' } });
  assert.equal(published?.report.preflight?.ok, true);
  const stored = (await readPublication(published?.plan.record.id ?? ''))?.record;
  assert.ok(stored && entriesOf(stored, 'createTopic').every(entry => entry.topicTypeFrom === 'Clash'), 'the mapping is recorded');
  // Reopened, no choice: the published Information topics are not retyped to the closest type.
  const writes = peer.state.receivedWrites;
  const reopened = await publishDraftBatch(batch, peer.target, connection);
  assert.equal(reopened?.report.preflight?.ok, true);
  assert.equal(peer.state.receivedWrites, writes, 'no silent retype');
  assert.ok([...peer.state.topics.values()].every(item => item.topic.topic_type === 'Information'));
});

test('a create recovered by the server check keeps what the server stored as the baseline (#8656 review)', async t => {
  const peer = await connectPeer(t, buildagilLike);
  const connection = { ...peer.connection, rules: buildagil };
  const batch = await reviewedBatch();
  peer.state.loseNextWriteResponse = true;
  const first = await publishDraftBatch(batch, peer.target, connection, { topicTypes: { Clash: 'Information' } });
  const lost = first ? entriesOf(first.plan.record, 'createTopic')[0] : undefined;
  const lostNow = (await readPublication(first?.plan.record.id ?? ''))?.record.entries.find(entry => entry.id === lost?.id);
  assert.equal(lostNow?.state, 'uncertain');
  const checked = await checkEntry(first?.plan.record.id ?? '', lostNow?.id ?? '', connection);
  assert.ok(checked.ok);
  assert.equal(checked.check.result, 'committed');
  const recovered = checked.record.entries.find(entry => entry.id === lostNow?.id);
  assert.equal(recovered?.receipt?.evidence, 'lookup');
  assert.equal(recovered?.receipt?.fields?.topic_type, 'Information');
  assert.equal(recovered?.receipt?.fields?.topic_status, undefined, 'the stored copy, not the sent status');

  // Finish the rest of the batch, then edit the recovered topic: no false conflict.
  await publishDraftBatch(batch, peer.target, connection, { topicTypes: { Clash: 'Information' } });
  const index = batch.topics.findIndex(topic => topic.guid === lostNow?.topicGuid);
  const edited = editDraftTopic(batch, batch.topics[index].guid, { title: 'Recovered topic, renamed' });
  assert.ok(edited.ok);
  const second = await publishDraftBatch(edited.batch, peer.target, connection, { topicTypes: { Clash: 'Information' } });
  assert.deepEqual(second?.report.blocked, [], 'no false remote conflict');
  assert.ok(second?.report.receipts.some(receipt => receipt.operation === 'updateTopic'));
});

test('buildagil: a status the chosen type cannot keep is not sent, and preflight says so', async t => {
  const peer = await connectPeer(t, buildagilLike);
  const batch = await reviewedBatch();
  const published = await publishDraftBatch(batch, peer.target, { ...peer.connection, rules: buildagil }, { topicTypes: { Clash: 'Information' } });
  assert.equal(published?.report.preflight?.ok, true, 'a warning, not a refusal');
  assert.deepEqual(published?.report.preflight?.warnings.filter(warning => warning.kind === 'withheld')
    .map(warning => [warning.topicGuid, warning.field, warning.value, warning.topicType]),
  batch.topics.map(topic => [topic.guid, 'topic_status', 'Open', 'Information']));
  const stored = (await readPublication(published?.plan.record.id ?? ''))?.record;
  for (const create of stored ? entriesOf(stored, 'createTopic') : []) {
    assert.equal(create.payload.topic_status, undefined, 'the status never left the client');
    assert.equal(create.payload.topic_type, 'Information');
    assert.equal(peer.state.topics.get(create.receipt?.remoteGuid ?? '')?.topic.topic_type, 'Information');
  }
  assert.equal(stored?.entries.length, 5);
  assert.ok(stored?.entries.every(entry => entry.state === 'done'));
});
