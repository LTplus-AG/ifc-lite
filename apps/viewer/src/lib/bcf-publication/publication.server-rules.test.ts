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
