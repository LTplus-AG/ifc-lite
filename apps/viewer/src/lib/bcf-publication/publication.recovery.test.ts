/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896 (P12): unknown outcomes against the loopback BCF peer. A response
// lost after the server committed is never resent; an explicit server check
// recovers the receipt, a reload never replays an interrupted write, and a
// backup import never dispatches on its own.

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectPeer, entriesOf, publish, reviewedBatch } from '@/test/bcf-publication-fixture';
import { createContentBackup, importContentBackup } from '../storage/content-backup';
import { readContentRows } from '../storage/content-database';
import { checkEntry, requeueAfterCheck } from './outbox-check';
import { decodePublication } from './outbox-codec';
import { dispatchPublication } from './outbox-dispatch';
import { planAndStore } from './outbox-publish';
import { markSending, replaceEntry, requeue } from './outbox-state';
import { mutatePublication, readPublication, recoverInterruptedPublications } from './outbox-store';

const empty = { validation: [], comparison: [], document: [] };

test('a lost create response is uncertain: dependents wait, a rerun sends nothing, the check finds the committed topic', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  peer.state.loseNextWriteResponse = true;
  const first = await publish(batch, peer);
  const [lostCreate, otherCreate] = entriesOf(first.record, 'createTopic');
  assert.equal(lostCreate.state, 'uncertain');
  assert.equal(lostCreate.failure?.code, 'no-response');
  assert.equal(otherCreate.state, 'done', 'other topics of the batch continue');
  assert.deepEqual(first.record.entries.filter(entry => entry.topicGuid === lostCreate.topicGuid).map(entry => entry.state),
    ['uncertain', 'queued', 'queued'], 'its viewpoint and comment wait instead of failing');
  assert.equal(peer.state.topics.size, 2, 'the server did commit the lost create');
  const writes = peer.state.receivedWrites;

  const rerun = await publish(batch, peer);
  assert.equal(rerun.added, 0, 'replanning never adds a second create for an uncertain topic');
  assert.equal(rerun.report.sent, 0);
  assert.equal(rerun.report.waiting.length, 2);
  assert.equal(peer.state.receivedWrites, writes, 'no blind retry');
  assert.throws(() => requeue(lostCreate), /cannot requeue/, 'requeue needs evidence of absence');

  const checked = await checkEntry(first.record.id, lostCreate.id, peer.connection);
  assert.ok(checked.ok);
  assert.equal(checked.check.result, 'committed');
  const committedGuid = [...peer.state.topics.values()].find(item => item.topic.guid !== otherCreate.receipt?.remoteGuid)?.topic.guid;
  assert.equal(checked.check.candidates[0].guid, committedGuid);
  assert.equal(peer.state.receivedWrites, writes, 'the check only reads');
  const settled = checked.record.entries.find(entry => entry.id === lostCreate.id);
  assert.equal(settled?.state, 'done');
  assert.equal(settled?.receipt?.evidence, 'lookup');

  const resumed = await dispatchPublication(first.record.id, peer.connection);
  assert.deepEqual(resumed.receipts.map(receipt => receipt.operation).sort(), ['createComment', 'createViewpoint']);
  assert.equal(peer.state.topics.size, 2, 'no duplicate topic');
  assert.equal(peer.state.topics.get(committedGuid ?? '')?.comments.length, 1);
});

test('lost viewpoint and comment responses are recovered by exact GUID and comment trailer', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  // Writes run create, viewpoint, comment, create, viewpoint: drop the 2nd and 3rd responses after commit.
  peer.state.loseResponsesOfWrites = new Set([2, 3]);
  const first = await publish(batch, peer);
  const uncertain = first.record.entries.filter(entry => entry.state === 'uncertain').map(entry => entry.operation);
  assert.deepEqual(uncertain, ['createViewpoint', 'createComment']);
  const created = entriesOf(first.record, 'createTopic')[0];
  const remote = peer.state.topics.get(created.receipt?.remoteGuid ?? '');
  assert.equal(remote?.viewpoints.length, 1, 'both effects were committed');
  assert.equal(remote?.comments.length, 1);
  const writes = peer.state.receivedWrites;
  for (const entry of first.record.entries.filter(item => item.state === 'uncertain')) {
    const checked = await checkEntry(first.record.id, entry.id, peer.connection);
    assert.ok(checked.ok);
    assert.equal(checked.check.result, 'committed', `${entry.operation} is recognised exactly`);
  }
  assert.equal(peer.state.receivedWrites, writes);
  const settled = (await readPublication(first.record.id))?.record;
  assert.ok(settled?.entries.every(entry => entry.state === 'done'));
  const rerun = await publish(batch, peer);
  assert.equal(rerun.report.sent, 0);
  assert.equal(remote?.viewpoints.length, 1, 'no duplicate viewpoint');
  assert.equal(remote?.comments.length, 1, 'no duplicate comment');
});

test('a write interrupted by a reload becomes uncertain; queued work resumes, and only an absence check requeues it', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  const planned = await planAndStore(batch, peer.target);
  assert.ok(planned);
  const firstCreate = entriesOf(planned.record, 'createTopic')[0];
  // The page closed right after committing the intent, before the request left.
  assert.ok(await mutatePublication(planned.record.id, current => current
    ? replaceEntry(current, markSending(current.entries.find(entry => entry.id === firstCreate.id) ?? firstCreate, new Date().toISOString()), new Date().toISOString())
    : null));
  assert.equal(await recoverInterruptedPublications(), 1);
  const resumed = await dispatchPublication(planned.record.id, peer.connection);
  assert.equal(peer.state.topics.size, 1, 'only the other topic was created');
  assert.equal(resumed.waiting.length, 2);
  const stored = (await readPublication(planned.record.id))?.record;
  const interrupted = stored?.entries.find(entry => entry.id === firstCreate.id);
  assert.equal(interrupted?.state, 'uncertain');
  assert.equal(interrupted?.failure?.code, 'interrupted');

  const requeued = await requeueAfterCheck(planned.record.id, firstCreate.id, peer.connection);
  assert.ok(requeued.ok);
  assert.equal(requeued.check.result, 'absent');
  const finished = await dispatchPublication(planned.record.id, peer.connection);
  assert.equal(finished.receipts.length, 3);
  assert.equal(peer.state.topics.size, 2);
  assert.ok((await readPublication(planned.record.id))?.record.entries.every(entry => entry.state === 'done'));
});

test('a backup import arrives blocked, never dispatches, and keeps done receipts', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  peer.state.loseNextWriteResponse = true;
  const first = await publish(batch, peer);
  const stored = await readPublication(first.record.id);
  assert.ok(stored);
  const backup = createContentBackup({ ...empty, bcfOutbox: [stored.record] });
  const reopened = JSON.parse(JSON.stringify(backup)) as typeof backup;
  // Import into a fresh browser profile: no local record exists.
  const tx = await (await import('../storage/content-database')).contentTransaction('items', 'readwrite');
  tx.objectStore('items').clear();
  await new Promise(resolve => { tx.oncomplete = resolve; });
  assert.equal(await importContentBackup(reopened), 1, 'first import');
  const imported = decodePublication((await readContentRows('bcfOutbox'))[0].payload);
  assert.ok(imported?.imported);
  assert.deepEqual(imported.entries.map(entry => entry.state), stored.record.entries.map(entry =>
    entry.state === 'done' || entry.state === 'failed' ? entry.state : 'blocked'));
  const writes = peer.state.receivedWrites;
  const report = await dispatchPublication(imported.id, peer.connection);
  assert.equal(report.sent, 0);
  assert.equal(peer.state.receivedWrites, writes, 'an imported intent is never dispatched by itself');
  const lost = imported.entries.find(entry => entry.operation === 'createTopic' && entry.state === 'blocked');
  assert.ok(lost);
  const checked = await checkEntry(imported.id, lost.id, peer.connection);
  assert.ok(checked.ok);
  assert.equal(checked.check.result, 'committed');
  assert.equal(peer.state.topics.size, 2);

  assert.equal(await importContentBackup(reopened), 0, 'the same backup again is recognised by provenance');
  // A different backup of the same record id (another tab's export) forks a blocked copy; the local record is untouched.
  const other = createContentBackup({ ...empty, bcfOutbox: [{ ...stored.record, batchName: 'Round 1 (other tab)' }] });
  assert.equal(await importContentBackup(other), 1, 'conflicting import');
  const rows = (await readContentRows('bcfOutbox')).map(row => decodePublication(row.payload));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row?.entries.every(entry => entry.state !== 'queued' && entry.state !== 'sending')));
});
