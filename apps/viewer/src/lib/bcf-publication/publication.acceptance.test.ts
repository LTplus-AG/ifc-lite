/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896 (P12): connected publication through the durable outbox against the
// loopback BCF peer — creates, comments, viewpoints, reruns, updates and
// preflight refusals. Every request is real HTTP; nothing is mocked.

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProjectAsBCF } from '@ifc-lite/bcf-api';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_USER } from '@/test/bcf-http-server';
import { connectPeer, entriesOf, publish, reviewedBatch } from '@/test/bcf-publication-fixture';
import { editDraftTopic } from '../bcf-drafts/draft-edit';
import { parseDraftFooter } from '../bcf-drafts/draft-footer';
import { settleRemoteConflict } from './outbox-check';
import { dispatchPublication } from './outbox-dispatch';
import { readPublication } from './outbox-store';

test('publishing creates topics, viewpoints and comments with one receipt each, and a rerun creates nothing', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  const first = await publish(batch, peer);
  assert.equal(first.report.preflight?.ok, true);
  assert.equal(first.report.sent, 5, '2 topics, 2 viewpoints, 1 comment');
  assert.equal(peer.state.acceptedWrites, 5);
  assert.ok(first.record.entries.every(entry => entry.state === 'done' && entry.receipt?.evidence === 'response'));
  const pulled = await fetchProjectAsBCF(peer.connection.client as Parameters<typeof fetchProjectAsBCF>[0], LOCAL_BCF_PROJECT, { includeSnapshots: false });
  assert.equal(pulled.project.topics.size, 2);
  for (const created of entriesOf(first.record, 'createTopic')) {
    const remote = pulled.project.topics.get(created.receipt?.remoteGuid ?? '');
    const draft = batch.topics.find(topic => topic.guid === created.topicGuid);
    assert.ok(remote && draft);
    assert.equal(remote.title, draft.title);
    assert.equal(parseDraftFooter(remote.description)?.topicGuid, draft.guid, 'the server topic names its local draft topic');
    assert.equal(remote.viewpoints[0].guid, draft.viewpoint?.guid, 'client-chosen viewpoint GUID');
    assert.deepEqual(new Set(remote.viewpoints[0].components?.selection?.map(item => item.ifcGuid)),
      new Set(draft.viewpoint?.components?.selection?.map(item => item.ifcGuid)));
  }
  const rerun = await publish(batch, peer);
  assert.equal(rerun.added, 0, 'same batch, same project: nothing new to plan');
  assert.equal(rerun.report.sent, 0);
  assert.equal(peer.state.receivedWrites, 5, 'no duplicate creation');
});

test('an edited topic publishes one update; server comments and viewpoints stay attached', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  const first = await publish(batch, peer);
  const edited = editDraftTopic(batch, batch.topics[0].guid, { title: 'Riser (resolved on site)', topicStatus: 'Resolved' });
  assert.ok(edited.ok);
  const second = await publish(edited.batch, peer);
  assert.equal(second.added, 1);
  assert.deepEqual(second.report.receipts.map(receipt => receipt.operation), ['updateTopic']);
  const remoteGuid = entriesOf(first.record, 'createTopic')[0].receipt?.remoteGuid ?? '';
  const remote = peer.state.topics.get(remoteGuid);
  assert.equal(remote?.topic.title, 'Riser (resolved on site)');
  assert.equal(remote?.topic.topic_status, 'Resolved');
  assert.equal(remote?.comments.length, 1);
  assert.equal(remote?.viewpoints.length, 1);
  assert.equal(peer.state.topics.size, 2);
});

test('a remote edit since the last publication blocks the update until the coordinator overwrites it', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  const first = await publish(batch, peer);
  const remoteGuid = entriesOf(first.record, 'createTopic')[0].receipt?.remoteGuid ?? '';
  await peer.connection.client.updateTopic(LOCAL_BCF_PROJECT, remoteGuid, { title: 'Renamed by the architect', topic_status: 'Open' });
  const writes = peer.state.receivedWrites;
  const edited = editDraftTopic(batch, batch.topics[0].guid, { topicStatus: 'Resolved' });
  assert.ok(edited.ok);
  const second = await publish(edited.batch, peer);
  assert.equal(second.report.blocked.length, 1);
  assert.equal(peer.state.receivedWrites, writes, 'no PUT over a conflicting human edit');
  assert.equal(peer.state.topics.get(remoteGuid)?.topic.title, 'Renamed by the architect');
  const update = entriesOf(second.record, 'updateTopic')[0];
  assert.equal(update.blocked, 'remote-conflict');
  assert.ok(await settleRemoteConflict(second.record.id, update.id, 'overwrite'));
  const resumed = await dispatchPublication(second.record.id, peer.connection);
  assert.deepEqual(resumed.receipts.map(receipt => receipt.operation), ['updateTopic']);
  assert.equal(peer.state.topics.get(remoteGuid)?.topic.topic_status, 'Resolved');
});

test('preflight refuses revoked permission, server vocabulary and unknown assignees with nothing sent', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  peer.state.writesAllowed = false;
  const revoked = await publish(batch, peer);
  assert.equal(revoked.report.stopped, 'preflight');
  assert.deepEqual(revoked.report.preflight?.issues.map(issue => [issue.kind, issue.value]), [['permission', 'createTopic']]);
  assert.equal(peer.state.receivedWrites, 0);
  assert.ok(revoked.record.entries.every(entry => entry.state === 'queued'), 'refused before any intent was sent');

  peer.state.writesAllowed = true;
  const invented = editDraftTopic(batch, batch.topics[1].guid, { priority: 'Low', assignedTo: 'nobody@example.test' });
  assert.ok(invented.ok);
  const vocabulary = await publish(invented.batch, peer);
  assert.equal(vocabulary.report.stopped, 'preflight');
  assert.deepEqual(vocabulary.report.preflight?.issues.map(issue => [issue.kind, issue.field, issue.value]),
    [['vocabulary', 'priority', 'Low'], ['assignee', 'assigned_to', 'nobody@example.test']]);
  assert.deepEqual(vocabulary.report.preflight?.issues[0].allowed, ['Normal', 'High']);
  assert.equal(peer.state.receivedWrites, 0);

  const mapped = editDraftTopic(batch, batch.topics[1].guid, { assignedTo: LOCAL_BCF_USER });
  assert.ok(mapped.ok);
  const accepted = await publish(mapped.batch, peer);
  assert.equal(accepted.report.preflight?.ok, true);
  const assigned = entriesOf(accepted.record, 'createTopic').find(entry => entry.topicGuid === batch.topics[1].guid);
  assert.equal(peer.state.topics.get(assigned?.receipt?.remoteGuid ?? '')?.topic.assigned_to, LOCAL_BCF_USER,
    'an assignee chosen from the server user list is published');
  assert.equal((await readPublication(accepted.record.id))?.record.entries.filter(entry => entry.state === 'done').length, 5);
});

test('a revoked token fails before any write; the stored queue is unchanged', async t => {
  const peer = await connectPeer(t);
  peer.state.tokenValid = false;
  const batch = await reviewedBatch();
  await assert.rejects(publish(batch, peer), (error: unknown) => error instanceof Error && /token rejected/i.test(error.message));
  assert.equal(peer.state.receivedWrites, 0);
});
