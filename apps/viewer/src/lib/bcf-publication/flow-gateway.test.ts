/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896: Flow BCF write nodes share the outbox safeguards. The gateway is
// driven exactly as `bcf.createTopic` drives it, with the real BCF client
// sending to the loopback peer.

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BcfApiError, type BcfTopicWriteDto } from '@ifc-lite/bcf-api';
import type { BcfWriteIntent } from '@ifc-lite/flow-nodes';
import { connectPeer } from '@/test/bcf-publication-fixture';
import { LOCAL_BCF_PROJECT } from '@/test/bcf-http-server';
import { checkEntry, resolveWithCandidate } from './outbox-check';
import { createViewerBcfWriteGateway, flowPublicationId } from './flow-gateway';
import { readPublication } from './outbox-store';

function intent(baseUrl: string, payload: BcfTopicWriteDto): BcfWriteIntent {
  return { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload };
}

test('a lost Flow write is recorded uncertain and an identical rerun is refused without sending', async t => {
  const peer = await connectPeer(t);
  const gateway = createViewerBcfWriteGateway();
  const write = { title: 'Flow: missing fire rating', topic_status: 'Open' };
  const send = () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, write);
  peer.state.loseNextWriteResponse = true;
  await assert.rejects(gateway.write(intent(peer.baseUrl, write), send), /outcome unknown.*check the server there/);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  const record = (await readPublication(id))?.record;
  assert.equal(record?.entries[0].state, 'uncertain');
  assert.equal(JSON.stringify(record).includes('local-test-token'), false, 'the bearer token is never persisted');
  await assert.rejects(gateway.write(intent(peer.baseUrl, write), send), /identical earlier write .* has an unknown outcome/);
  assert.equal(peer.state.receivedWrites, 1, 'the rerun never reached the server');
  assert.equal(peer.state.topics.size, 1);

  const other = { title: 'Flow: a different topic' };
  const created = await gateway.write(intent(peer.baseUrl, other), () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, other));
  assert.equal(peer.state.topics.get(created.guid)?.topic.title, other.title, 'unrelated writes are not blocked');

  // Flow writes carry no correlation marker: a title match is a candidate, never an automatic receipt.
  const checked = await checkEntry(id, record?.entries[0].id ?? '', peer.connection);
  assert.ok(checked.ok);
  assert.equal(checked.check.result, 'ambiguous');
  assert.equal(checked.check.candidates.length, 1);
  assert.ok(await resolveWithCandidate(id, record?.entries[0].id ?? '', checked.check.candidates[0].guid));
  assert.equal((await readPublication(id))?.record.entries[0].receipt?.evidence, 'user-choice');
  assert.equal(await resolveWithCandidate(id, record?.entries[1]?.id ?? 'x', 'not-a-candidate'), null, 'only recorded candidates can be chosen');
});

test('an HTTP refusal is a definite failure: the node gets the server error and may run again', async t => {
  const peer = await connectPeer(t);
  const gateway = createViewerBcfWriteGateway();
  const write = { title: 'Invented status', topic_status: 'Invented' };
  const send = () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, write);
  await assert.rejects(gateway.write(intent(peer.baseUrl, write), send), (error: unknown) => error instanceof BcfApiError && error.status === 400);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  assert.equal((await readPublication(id))?.record.entries[0].state, 'failed');
  await assert.rejects(gateway.write(intent(peer.baseUrl, write), send), (error: unknown) => error instanceof BcfApiError);
  assert.equal(peer.state.receivedWrites, 2, 'a definite refusal does not block a rerun');
  assert.equal(peer.state.topics.size, 0);
});
