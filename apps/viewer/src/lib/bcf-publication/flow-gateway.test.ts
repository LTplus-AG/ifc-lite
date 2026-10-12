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
import { BROWSER_FEATURES, createStandardRegistry, type BcfWriteIntent, type BcfWriteGateway, type FlowHost } from '@ifc-lite/flow-nodes';
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

test('#7476 browser schema-key exemptions never admit credential values or fields in the wrong context', async t => {
  const peer = await connectPeer(t, { token: 'id', guidPrefix: 'cafe' });
  const gateway = createViewerBcfWriteGateway();
  const clean = intent(peer.baseUrl, { title: 'Clean topic' });
  for (const bad of [
    { ...clean, payload: { title: 'Contains id credential' } },
    { ...clean, payload: { title: 'Clean topic', id: 'unknown field' } },
    { ...clean, id: 'unknown intent field' },
    { ...clean, baseUrl: peer.baseUrl.replace('http://', 'http://user:password@') },
    { ...clean, payload: { title: 'Authorization: Bearer 12345678' } },
  ]) {
    await assert.rejects(gateway.write(bad, () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean topic' }), ['id']), /credentials/);
    assert.equal(peer.state.receivedWriteAttempts, 0);
  }
  assert.equal(await readPublication(flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT })), undefined);
  const created = await gateway.write(clean, () => peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean topic' }), ['id']);
  assert.equal(peer.state.acceptedWrites, 1);
  assert.equal(peer.state.topics.get(created.guid)?.topic.title, 'Clean topic');
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

for (const kind of ['browser', 'own-client'] as const) {
  for (const source of ['literal', 'Player'] as const) {
    for (const [token, credentialGuid] of [['beef', true], ['beef', false], ['id', false]] as const) {
      test(`#7476 ${kind} gateway preserves ${source} identifier semantics (credential GUID: ${credentialGuid}, bearer: ${token})`, async t => {
        const peer = await connectPeer(t, { token, guidPrefix: credentialGuid ? token : 'cafe', echoWriteToken: token === 'id' });
        const hostname = `${kind}-${source.toLowerCase()}-${token === 'id' ? 'short' : credentialGuid ? 'blocked' : 'clean'}.bcf-peer.test`;
        const baseUrl = `https://${hostname}/bcf`;
        const parsed = parseCapabilities([`network.fetch:${hostname}`]);
        assert.ok(parsed.ok);
        // An actual third-party client-backed gateway may not call the supplied send.
        // Exercise its real authenticated HTTP response, not an injected receipt DTO.
        class OwnClientGateway extends BcfApiClient implements BcfWriteGateway {
          write<T extends { guid: string }>(intent: BcfWriteIntent, _send: () => Promise<T>): Promise<T> {
            assert.equal(intent.baseUrl, baseUrl);
            const route = `${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`
              + (intent.operation === 'createComment' ? `/${intent.topicGuid}/comments` : '');
            return this.requestJson<T>(route, { method: 'POST', body: intent.payload });
          }
        }
        const gateway = kind === 'browser' ? createViewerBcfWriteGateway()
          : new OwnClientGateway({ baseUrl: peer.baseUrl, getAccessToken: () => token });
        const host: FlowHost = {
          bim: createBimContext({ backend: new LocalBackend(useViewerStore) }),
          grants: parsed.value, networkGrants: parsed.value, bcfWrites: gateway,
          networkTransport: (url, init) => {
            assert.equal(url.origin, `https://${hostname}`);
            return fetch(peer.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
          },
        };
        const doc: FlowDocument = { flowVersion: 1, id: 'receipt-contract', name: 'Receipt contract',
          capabilities: [`network.fetch:${hostname}`],
          inputs: source === 'Player' ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [],
          nodes: [{ id: 'write', type: 'bcf.createTopic', params: {
            baseUrl, projectId: LOCAL_BCF_PROJECT, token: source === 'literal' ? token : 'unused-default',
            title: 'Clean topic', status: 'Open',
          } }, { id: 'comment', type: 'bcf.addComment', params: {
            baseUrl, projectId: LOCAL_BCF_PROJECT, token, comment: 'Clean relation',
          } }],
          edges: [{ from: ['write', 'guids'], to: ['comment', 'topicGuid'] }],
          outputs: [{ nodeId: 'write', port: 'guids', label: 'Topic keys' },
            { nodeId: 'comment', port: 'created', label: 'Comment' }],
        };
        const options = { host, registry: createStandardRegistry(), features: BROWSER_FEATURES,
          ...(source === 'Player' ? { inputs: { 'write.token': token } } : {}) };
        const result = await runFlow(doc, options);
        const expectedWrites = credentialGuid ? 1 : 2;
        assert.equal(peer.state.acceptedWrites, expectedWrites);
        assert.equal(peer.state.receivedWrites, expectedWrites);
        assert.equal(peer.state.receivedWriteAttempts, expectedWrites, 'no malformed downstream POST reached the server');
        assert.equal(peer.state.topics.size, 1);
        const retained = [...peer.state.topics.values()][0];
        assert.ok(retained.topic.guid.startsWith(credentialGuid ? token : 'cafe'));
        assert.equal(retained.comments.length, credentialGuid ? 0 : 1);
        if (token !== 'id') assert.equal(inspect(result, { depth: null }).includes(token), false, 'structural GUIDs are never emitted with a substituted bearer');
        assert.equal(result.ok, !credentialGuid);
        const record = (await readPublication(flowPublicationId({ serverUrl: baseUrl, projectId: LOCAL_BCF_PROJECT })))?.record;
        if (credentialGuid) {
          assert.match(result.reports.find(report => report.nodeId === 'write')?.error ?? '', /outcome.*unknown/);
          if (kind === 'browser') {
            assert.equal(record?.entries.length, 1);
            assert.equal(record?.entries[0].state, 'uncertain');
            assert.equal(record?.entries[0].receipt, undefined, 'no altered or credential-bearing receipt is saved');
            assert.equal(record?.entries[0].failure?.message.includes(token), false);
            assert.equal((await runFlow(doc, options)).ok, false);
            assert.equal(peer.state.receivedWriteAttempts, 1, 'owned unresolved intent prevents another send');
          } else assert.equal(record, undefined, 'independent gateway has no browser journal');
        } else {
          assert.equal(retained.comments[0].topic_guid, retained.topic.guid);
          assert.deepEqual(result.outputs.get('write')?.get('guids'), { kind: 'list', items: [retained.topic.guid] },
            'the exact clean server identifier reaches downstream output');
          const created = result.outputs.get('comment')?.get('created');
          assert.ok(created?.kind === 'list', 'the comment output is lifted over the topic GUID list');
          assert.equal(created.items.length, 1);
          const dto = created.items[0];
          assert.ok(dto && typeof dto === 'object');
          assert.equal(Reflect.get(dto, 'topic_guid'), retained.topic.guid, 'the returned relationship identifier remains exact');
          if (token === 'id') {
            assert.equal(retained.topic.title, 'Clean topic');
            assert.equal(retained.comments[0].comment, 'Clean relation');
            assert.equal(Reflect.get(dto, 'comment'), 'Server echoed [REDACTED]');
            const topics = result.outputs.get('write')?.get('topics');
            assert.ok(topics?.kind === 'list');
            const topic = topics.items[0];
            assert.ok(topic && typeof topic === 'object');
            assert.equal(Reflect.get(topic, 'description'), 'Server echoed [REDACTED]');
          }
          if (kind === 'browser') {
            assert.equal(record?.entries[0].receipt?.remoteGuid, retained.topic.guid);
            assert.equal(record?.entries[1].receipt?.remoteGuid, retained.comments[0].guid);
          }
        }
      });
    }
  }
}

for (const source of ['literal', 'Player'] as const) {
  test(`#7476 registered browser ${source} comment refuses a credential-bearing response relationship before receipt settlement`, async t => {
    const token = 'beef';
    const peer = await connectPeer(t, { token, guidPrefix: 'cafe',
      commentResponseTopicGuid: 'beef0000-0000-4000-8000-000000000001' });
    const parent = await peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Clean parent' });
    const hostname = `relationship-${source.toLowerCase()}.bcf-peer.test`;
    const baseUrl = `https://${hostname}/bcf`;
    const grants = parseCapabilities([`network.fetch:${hostname}`]);
    assert.ok(grants.ok);
    const doc: FlowDocument = { flowVersion: 1, id: 'relationship', name: 'Relationship',
      capabilities: [`network.fetch:${hostname}`], edges: [],
      inputs: source === 'Player' ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [],
      nodes: [{ id: 'write', type: 'bcf.addComment', params: { baseUrl, projectId: LOCAL_BCF_PROJECT,
        topicGuid: parent.guid, comment: 'Clean relation', token: source === 'literal' ? token : 'unused-default' } }],
      outputs: [{ nodeId: 'write', port: 'created', label: 'Comment' }] };
    const host: FlowHost = { bim: createBimContext({ backend: new LocalBackend(useViewerStore) }),
      grants: grants.value, networkGrants: grants.value, bcfWrites: createViewerBcfWriteGateway(),
      networkTransport: (url, init) => {
        assert.equal(url.origin, `https://${hostname}`);
        return fetch(peer.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
      } };
    const options = { host, registry: createStandardRegistry(), features: BROWSER_FEATURES,
      ...(source === 'Player' ? { inputs: { 'write.token': token } } : {}) };
    const result = await runFlow(doc, options);
    assert.equal(peer.state.acceptedWrites, 2);
    const retained = peer.state.topics.get(parent.guid)!;
    assert.equal(retained.comments.length, 1);
    assert.equal(retained.comments[0].topic_guid, parent.guid, 'the retained effect is independent of the overridden response DTO');
    assert.ok(retained.comments[0].guid.startsWith('cafe'));
    assert.equal(result.ok, false);
    assert.match(result.reports[0].error ?? '', /outcome.*unknown/);
    assert.equal(result.outputs.get('write')?.get('created'), undefined);
    assert.equal(inspect(result, { depth: null }).includes(token), false);
    const record = (await readPublication(flowPublicationId({ serverUrl: baseUrl, projectId: LOCAL_BCF_PROJECT })))?.record;
    assert.equal(record?.entries[0].state, 'uncertain');
    assert.equal(record?.entries[0].receipt, undefined);
    assert.equal((await runFlow(doc, options)).ok, false);
    assert.equal(peer.state.receivedWriteAttempts, 2, 'an identical unresolved comment is never resent');
  });
}

// #7476: public raw callbacks bypass sendBcfWrite, so the host must validate before markDone too.
for (const field of ['guid', 'topic_guid', 'viewpoint_guid', 'reply_to_comment_guid'] as const) {
  test(`#7476 raw browser callback refuses credential-bearing ${field} after a retained effect and blocks replay`, async t => {
    const token = 'beef';
    const unsafe = 'beef0000-0000-4000-8000-000000000999';
    const peer = await connectPeer(t, {
      token, guidPrefix: field === 'guid' ? 'beef' : 'cafe',
      ...(field === 'topic_guid' ? { commentResponseTopicGuid: unsafe } : {}),
      ...(field === 'viewpoint_guid' ? { commentResponseViewpointGuid: unsafe } : {}),
      ...(field === 'reply_to_comment_guid' ? { commentResponseReplyToCommentGuid: unsafe } : {}),
    });
    const parent = field === 'guid' ? undefined : await peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Parent topic' });
    const gateway = createViewerBcfWriteGateway();
    const write: BcfWriteIntent = parent ? { nodeType: 'bcf.addComment', operation: 'createComment', baseUrl: peer.baseUrl,
      version: '2.1', projectId: LOCAL_BCF_PROJECT, topicGuid: parent.guid, payload: { comment: 'Safe comment' } }
      : intent(peer.baseUrl, { title: 'Safe topic' });
    const send = () => parent ? peer.connection.client.createComment(LOCAL_BCF_PROJECT, parent.guid, { comment: 'Safe comment' })
      : peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Safe topic' });
    let returned: unknown;
    let failure: unknown;
    try { returned = await gateway.write(write, send, [token]); } catch (error) { failure = error; }
    const count = parent ? 2 : 1;
    assert.equal(peer.state.receivedWrites, count);
    assert.equal(peer.state.acceptedWrites, count);
    const retained = [...peer.state.topics.values()][0];
    assert.ok(retained);
    if (parent) {
      assert.equal(retained.comments.length, 1);
      assert.equal(retained.comments[0].topic_guid, parent.guid, 'independent retained relationship remains the actual parent');
      assert.equal(retained.comments[0].comment, 'Safe comment');
    } else assert.equal(retained.topic.title, 'Safe topic');
    assert.ok(failure instanceof Error, 'the retained effect must remain unknown');
    assert.match(failure.message, /outcome unknown/);
    assert.equal(returned, undefined, 'no unsafe receipt DTO is returned');
    const id = flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT });
    const record = (await readPublication(id))?.record;
    assert.equal(record?.entries[0].state, 'uncertain');
    assert.equal(record?.entries[0].receipt, undefined);
    assert.equal(inspect(record, { depth: null }).includes(token), false);
    await assert.rejects(createViewerBcfWriteGateway().write(write, send, [token]), /identical earlier write/);
    assert.equal(peer.state.receivedWrites, count, 'fresh gateway cannot replay the retained effect');
  });
}

test('#7476 raw browser callback accepts clean primary and nullable optional relationship identifiers', async t => {
  const peer = await connectPeer(t, { token: 'beef', guidPrefix: 'cafe', commentResponseViewpointGuid: null, commentResponseReplyToCommentGuid: null });
  const parent = await peer.connection.client.createTopic(LOCAL_BCF_PROJECT, { title: 'Parent topic' });
  const write: BcfWriteIntent = { nodeType: 'bcf.addComment', operation: 'createComment', baseUrl: peer.baseUrl,
    version: '2.1', projectId: LOCAL_BCF_PROJECT, topicGuid: parent.guid, payload: { comment: 'Safe comment' } };
  const result = await createViewerBcfWriteGateway().write(write,
    () => peer.connection.client.createComment(LOCAL_BCF_PROJECT, parent.guid, { comment: 'Safe comment' }), ['beef']);
  assert.equal(peer.state.acceptedWrites, 2);
  const retained = peer.state.topics.get(parent.guid)?.comments[0];
  assert.ok(retained);
  assert.equal(result.guid, retained.guid);
  assert.equal(result.topic_guid, parent.guid);
  assert.equal(result.viewpoint_guid, null);
  assert.equal(result.reply_to_comment_guid, null);
  const record = (await readPublication(flowPublicationId({ serverUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT })))?.record;
  assert.equal(record?.entries[0].state, 'done');
  assert.equal(record?.entries[0].receipt?.remoteGuid, retained.guid);
});
