/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { connectPeer as connectLoopbackPeer } from '@/test/bcf-publication-fixture';
import { LOCAL_BCF_PROJECT } from '@/test/bcf-http-server';
import { createViewerBcfWriteGateway, flowPublicationId } from './flow-gateway';
import { readPublication } from './outbox-store';

// Separate from the existing gateway file, which can run on another CI shard.
const connectPeer = (t: Parameters<typeof connectLoopbackPeer>[0], options: Parameters<typeof connectLoopbackPeer>[1] = {}) =>
  connectLoopbackPeer(t, { ...options, port: 38424 });

// #7374/#7476: this is a legitimate opaque UUID allocation collision, not an API-return mock.
test('#7374 a generated UUID cannot persist a short bearer after a real authenticated effect', async t => {
  const token = 'beef';
  const peer = await connectPeer(t, { token, guidPrefix: 'cafe' });
  const generated = '00000000-0000-4000-8000-00000000beef';
  let draws = 0;
  t.mock.method(crypto, 'randomUUID', () => ++draws === 1 ? generated : '00000000-0000-4000-8000-00000000cafe');
  const result = await createViewerBcfWriteGateway().write({ nodeType: 'bcf.createTopic', operation: 'createTopic',
    baseUrl: peer.baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Clean metadata effect' } },
    () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean metadata effect' }), [token]);
  assert.equal(peer.state.receivedWrites, 1);
  assert.equal(peer.state.acceptedWrites, 1);
  const retained = [...peer.state.topics.values()][0].topic;
  assert.equal(retained.title, 'Clean metadata effect');
  assert.equal(result.guid, retained.guid);
  assert.equal(result.guid.includes(token), false);
  const record = (await readPublication(flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT })))?.record;
  assert.equal(record?.entries.length, 1);
  assert.equal(record?.entries[0].state, 'done');
  assert.equal(record?.entries[0].receipt?.remoteGuid, retained.guid);
  assert.equal(inspect(record, { depth: null }).includes(token), false, 'owned generated metadata must not introduce known credential text');
  assert.equal(draws, 2, 'one colliding allocation is discarded before the real effect');
});

test('#7374 repeated unsafe generated UUIDs refuse before HTTP or durable admission', async t => {
  const peer = await connectPeer(t, { token: 'beef', guidPrefix: 'cafe' });
  let draws = 0;
  t.mock.method(crypto, 'randomUUID', () => { draws++; return '00000000-0000-4000-8000-00000000beef'; });
  let failure: unknown;
  try { await createViewerBcfWriteGateway().write({ nodeType: 'bcf.createTopic', operation: 'createTopic',
    baseUrl: peer.baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Clean metadata effect' } },
    () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean metadata effect' }), ['beef']); } catch (error) { failure = error; }
  for (const retained of peer.state.topics.values()) {
    assert.equal(retained.topic.title, 'Clean metadata effect');
    assert.equal(retained.topic.guid.includes('beef'), false);
  }
  assert.equal(peer.state.receivedWrites, 0);
  assert.equal(peer.state.acceptedWrites, 0);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /credential-free journal identifier/);
  assert.equal(draws, 16);
  assert.equal(await readPublication(flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT })), undefined);
});

test('#7374 a generated timestamp collision refuses without changing stable replay identities', async t => {
  const peer = await connectPeer(t, { token: '2030', guidPrefix: 'cafe' });
  t.mock.method(crypto, 'randomUUID', () => '00000000-0000-4000-8000-00000000cafe');
  const gateway = createViewerBcfWriteGateway(() => new Date('2030-01-01T00:00:00.000Z'));
  let failure: unknown;
  try { await gateway.write({ nodeType: 'bcf.createTopic', operation: 'createTopic',
    baseUrl: peer.baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Clean metadata effect' } },
    () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean metadata effect' }), ['2030']); } catch (error) { failure = error; }
  for (const retained of peer.state.topics.values()) {
    assert.equal(retained.topic.title, 'Clean metadata effect');
    assert.equal(retained.topic.guid.includes('2030'), false);
  }
  assert.equal(peer.state.receivedWriteAttempts, 0);
  assert.equal(peer.state.acceptedWrites, 0);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /generated journal metadata/);
  assert.equal(await readPublication(flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT })), undefined);
});

test('#7374 an unsafe receipt timestamp reports an unknown accepted outcome and blocks replay', async t => {
  const token = '2030';
  const peer = await connectPeer(t, { token, guidPrefix: 'cafe' });
  t.mock.method(crypto, 'randomUUID', () => '00000000-0000-4000-8000-00000000cafe');
  let dates = 0;
  const gateway = createViewerBcfWriteGateway(() => ++dates === 1 ? new Date() : new Date('2030-01-01T00:00:00.000Z'));
  const intent = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
    baseUrl: peer.baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Clean metadata effect' } };
  const send = () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, intent.payload);
  let failure: unknown;
  let returned: unknown;
  try { returned = await gateway.write(intent, send, [token]); } catch (error) { failure = error; }
  assert.equal(peer.state.receivedWrites, 1);
  assert.equal(peer.state.acceptedWrites, 1);
  const retained = [...peer.state.topics.values()][0].topic;
  assert.equal(retained.title, intent.payload.title);
  assert.equal(retained.guid.includes(token), false);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  const record = (await readPublication(id))?.record;
  assert.equal(record?.entries.length, 1);
  assert.equal(record?.entries[0].state, 'sending');
  assert.equal(record?.entries[0].receipt, undefined);
  assert.equal(inspect(record, { depth: null }).includes(token), false);
  assert.equal(returned, undefined);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /outcome unknown.*server may have applied/);
  assert.equal(failure.message.includes(token), false);
  assert.doesNotMatch(failure.message, /publication refused/);
  await assert.rejects(createViewerBcfWriteGateway().write(intent, send, [token]), /identical earlier write.*unknown outcome/);
  assert.equal(peer.state.receivedWrites, 1);
  assert.equal(peer.state.acceptedWrites, 1);
  assert.equal((await readPublication(id))?.record.entries[0].state, 'sending');
});

test('#7374 replay diagnostics do not expose stored metadata newly enrolled as a credential', async t => {
  const peer = await connectPeer(t, { token: 'beef', guidPrefix: 'cafe' });
  t.mock.method(crypto, 'randomUUID', () => '00000000-0000-4000-8000-00000000cafe');
  const gateway = createViewerBcfWriteGateway(() => new Date('2030-01-01T00:00:00.000Z'));
  const intent = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
    baseUrl: peer.baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Clean metadata effect' } };
  const send = () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, intent.payload);
  peer.state.loseNextWriteResponse = true;
  let firstFailure: unknown;
  try { await gateway.write(intent, send, ['beef']); } catch (error) { firstFailure = error; }
  assert.equal(peer.state.receivedWrites, 1);
  assert.equal(peer.state.acceptedWrites, 1);
  const retained = [...peer.state.topics.values()][0].topic;
  assert.equal(retained.title, intent.payload.title);
  assert.equal(retained.guid.includes('beef'), false);
  assert.ok(firstFailure instanceof Error);
  assert.match(firstFailure.message, /outcome unknown/);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  const record = (await readPublication(id))?.record;
  assert.equal(record?.entries[0].state, 'uncertain');
  assert.equal(record?.entries[0].queuedAt, '2030-01-01T00:00:00.000Z');
  let replayFailure: unknown;
  try { await createViewerBcfWriteGateway().write(intent, send, ['beef', '2030']); } catch (error) { replayFailure = error; }
  assert.equal(peer.state.receivedWrites, 1);
  assert.equal(peer.state.acceptedWrites, 1);
  assert.ok(replayFailure instanceof Error);
  assert.match(replayFailure.message, /identical earlier write.*unknown outcome/);
  assert.equal(replayFailure.message.includes('2030'), false);
  assert.equal(replayFailure.message.includes('beef'), false);
  assert.equal((await readPublication(id))?.record.entries[0].state, 'uncertain');
});
