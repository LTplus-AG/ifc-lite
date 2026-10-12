/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896: Flow BCF write nodes share the outbox safeguards. The gateway is
// driven exactly as `bcf.createTopic` drives it, with the real BCF client
// sending to the loopback peer.

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { BcfApiClient, BcfApiError, type BcfTopicWriteDto } from '@ifc-lite/bcf-api';
import { BROWSER_FEATURES, createStandardRegistry, type BcfWriteIntent, type FlowHost } from '@ifc-lite/flow-nodes';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { connectPeer } from '@/test/bcf-publication-fixture';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from '@/test/bcf-http-server';
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

// #7374: the canonical node passes its resolved literal/Player bearer ephemerally.
test('a known bearer in Flow payload is refused before browser persistence or effect', async t => {
  const peer = await connectPeer(t);
  const gateway = createViewerBcfWriteGateway();
  const payload = { title: 'Accidental local-test-token content' };
  await assert.rejects(gateway.write(intent(peer.baseUrl, payload),
    () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, payload), ['local-test-token']), /credentials must not enter durable state/);
  assert.equal(peer.state.receivedWrites, 0);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  assert.equal(await readPublication(id), undefined);
});

for (const status of [401, 503]) {
  test(`#7374 browser Flow returns no literal bearer in HTTP ${status} diagnostics, detail or causes`, async t => {
    const token = 'literal"token\\path';
    const echoed = status === 401 ? token : JSON.stringify(token).slice(1, -1);
    let requests = 0;
    const server = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      requests++;
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: `Invalid bearer ${echoed}` }));
    });
    await new Promise<void>((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); ready(); });
    });
    t.after(() => new Promise<void>((closed, reject) => {
      server.close(error => error ? reject(error) : closed()); server.closeAllConnections();
    }));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/bcf`;
    const client = new BcfApiClient({ baseUrl, getAccessToken: () => token });
    const payload = { title: `HTTP ${status} recovery` };
    const gateway = createViewerBcfWriteGateway();
    await assert.rejects(gateway.write(intent(baseUrl, payload),
      () => client.createTopic(LOCAL_BCF_PROJECT, payload), [token]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(JSON.stringify(token).slice(1, -1)), false);
      assert.equal(error.cause, undefined, 'a raw remote error must not escape as a cause');
      assert.equal(inspect(error).includes(token), false, 'the returned error and cause contain no raw token');
      assert.equal(inspect(error).includes(JSON.stringify(token).slice(1, -1)), false, 'encoded tokens cannot bypass redaction');
      assert.match(error.message, /\[redacted\]/);
      if (status === 401) assert.ok(error instanceof BcfApiError && error.status === 401 && error.isAuthError);
      return true;
    });
    const record = (await readPublication(flowPublicationId({ serverUrl: baseUrl, projectId: LOCAL_BCF_PROJECT })))?.record;
    assert.equal(record?.entries[0].state, status === 401 ? 'failed' : 'uncertain');
    assert.equal(JSON.stringify(record).includes(JSON.stringify(token).slice(1, -1)), false);
    assert.equal(requests, 1, 'the real client sent only the original request');
  });
}


// #7374: the public browser gateway also accepts real clients with manual redirect transports.
test('a retained POST answered with a typed BcfApiError303 remains uncertain until manual checked settlement', async t => {
  const peer = await connectPeer(t, { afterWriteStatus: 303 });
  const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => LOCAL_BCF_TOKEN,
    fetchFn: (url, init) => fetch(url, { ...init, redirect: 'manual' }) });
  const gateway = createViewerBcfWriteGateway();
  const payload = { title: 'Manual redirect retained effect', topic_status: 'Open' };
  let apiFailure: unknown, failure: unknown;
  const send = async () => {
    try { return await client.createTopic(LOCAL_BCF_PROJECT, payload); }
    catch (error) { apiFailure = error; throw error; }
  };
  try { await gateway.write(intent(peer.baseUrl, payload), send); }
  catch (error) { failure = error; }
  assert.equal(peer.state.acceptedWrites, 1);
  assert.equal(peer.state.topics.size, 1);
  const guid = [...peer.state.topics.keys()][0];
  assert.ok(apiFailure instanceof BcfApiError && apiFailure.status === 303, 'the actual HTTP client produced the typed303 error');
  assert.match(String(failure), /outcome unknown/);
  const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
  const record = await readPublication(id);
  assert.equal(record?.record.entries[0].state, 'uncertain');
  await assert.rejects(gateway.write(intent(peer.baseUrl, payload), send), /identical earlier write/);
  assert.equal(peer.state.receivedWrites, 1, 'the repeated intent never dispatches');
  const entryId = record?.record.entries[0].id;
  assert.ok(entryId);
  const checked = await checkEntry(id, entryId, { ...peer.connection, client });
  assert.ok(checked.ok);
  assert.deepEqual(checked.check.candidates.map(candidate => candidate.guid), [guid]);
  assert.ok(await resolveWithCandidate(id, entryId, guid));
  assert.equal((await readPublication(id))?.record.entries[0].receipt?.remoteGuid, guid);
  assert.equal(peer.state.receivedWrites, 1, 'authorized GET and manual settlement never retry the POST');
});

test('#7374 a registered browser BCF node journals preflight denial as failed and permits repaired grants', async t => {
  const peer = await connectPeer(t);
  const baseUrl = 'https://denied-bcf.example.test/bcf';
  const parse = (host: string) => {
    const result = parseCapabilities([`network.fetch:${host}`]);
    assert.ok(result.ok);
    return result.value;
  };
  const gateway = createViewerBcfWriteGateway();
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const registry = createStandardRegistry();
  let transports = 0;
  const host: FlowHost = {
    bim, bcfWrites: gateway, grants: parse('bcf-peer.example.test'),
    networkGrants: parse('bcf-peer.example.test'),
    networkTransport: (url, init) => {
      transports++;
      assert.equal(url.origin, 'https://denied-bcf.example.test');
      return fetch(peer.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
    },
  };
  const doc: FlowDocument = {
    flowVersion: 1, id: 'browser-preflight', name: 'Browser preflight',
    capabilities: ['network.fetch:bcf-peer.example.test'], inputs: [], outputs: [], edges: [],
    nodes: [{ id: 'write', type: 'bcf.createTopic', params: {
      baseUrl, projectId: LOCAL_BCF_PROJECT, token: LOCAL_BCF_TOKEN,
      title: 'Denied before dispatch', status: 'Open',
    } }],
  };
  const denied = await runFlow(doc, { host, registry, features: BROWSER_FEATURES });
  assert.equal(peer.state.receivedWrites, 0);
  assert.equal(peer.state.acceptedWrites, 0);
  assert.equal(transports, 0, 'the canonical grant preflight never invoked transport');
  assert.equal(denied.ok, false);
  const id = flowPublicationId({ serverUrl: baseUrl, projectId: LOCAL_BCF_PROJECT });
  const failed = (await readPublication(id))?.record;
  assert.equal(failed?.entries.length, 1);
  assert.equal(failed?.entries[0].state, 'failed');
  assert.equal(failed?.entries[0].failure?.code, 'permission');
  const repairedGrants = parse('denied-bcf.example.test');
  const repaired = await runFlow({ ...doc, capabilities: ['network.fetch:denied-bcf.example.test'] },
    { host: { ...host, grants: repairedGrants, networkGrants: repairedGrants }, registry, features: BROWSER_FEATURES });
  assert.equal(peer.state.acceptedWrites, 1);
  assert.equal(peer.state.topics.size, 1);
  assert.equal(transports, 1);
  assert.equal(repaired.ok, true);
  const settled = (await readPublication(id))?.record;
  assert.equal(settled?.entries.length, 2);
  assert.equal(settled?.entries[1].state, 'done');
  assert.equal(settled?.entries[1].receipt?.remoteGuid, [...peer.state.topics.keys()][0]);
});
