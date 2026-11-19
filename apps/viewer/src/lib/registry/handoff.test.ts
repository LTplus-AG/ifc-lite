/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { startServer, closeAll, send } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { handoffContext, readHandoff, registryConnections, HANDOFF_PROTOCOL, type OciHandoff } from './handoff-contract';
import { exchangeRegistryToken, resourceSession } from './handoff-auth';
import { confirmPublication } from './handoff-publication';
import { pullHandoff, pushHandoff } from './handoff-client';

afterEach(closeAll);
const issuer = 'https://login.example.test/realms/demo';
const connection = { registry:'https://files.example.test', authorization_server:issuer, client_id:'ifc-lite' };

test('a handoff is a pinned content locator and accepts an independent authorization issuer', () => {
  const value = { protocol:HANDOFF_PROTOCOL, source:{registry:connection.registry,repository:'project/model',digest:'sha256:'+'a'.repeat(64)},intent:'edit' };
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.deepEqual(readHandoff('https://viewer.example.test/open-artifact#handoff='+encoded,[connection]),value);
  assert.throws(() => handoffContext({...value,source:{...value.source,registry:'https://unknown.example.test'}},[connection]));
  assert.throws(() => handoffContext({...value,source:{...value.source,digest:'issued'}},[connection]));
});

test('ordinary OAuth responses support downscoping and require no Subsoil session or identity fields', () => {
  const requested='repository:project/model:pull,push';
  const session=resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'repository:project/model:pull'},connection.registry,requested);
  assert.equal(session.scope,'repository:project/model:pull');
  assert.throws(() => resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'repository:other/model:pull'},connection.registry,requested));
});

test('push and pull use OCI and isolate source/destination tokens at the actual HTTP boundary', async () => {
  const fixture=pushRegistry({repository:'project/model',accept:authorization => authorization==='Bearer destination'});
  const server=await startServer(fixture.handler), scope='repository:project/model:pull,push';
  const session=resourceSession({access_token:'destination',token_type:'Bearer',expires_in:300,scope},server.origin,scope);
  const bytes=new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;');
  const saved=await pushHandoff(server.origin,'project/model','edited',bytes,'edited.ifc',session);
  const received=await pullHandoff(saved,session);
  assert.deepEqual(received.bytes,bytes);
  assert.equal(received.filename,'edited.ifc');
  assert(server.requests.filter(r => r.authorization).every(r => r.authorization==='Bearer destination'));
  const before=server.requests.length;
  await assert.rejects(pushHandoff(server.origin,'project/model','edited',bytes,'edited.ifc',session),/already exists/);
  assert(server.requests.slice(before).every(r => r.method==='GET'),'an existing version must be rejected before uploading');
  const afterExisting=server.requests.length;
  const other={...session,registry:'https://other.example.test'};
  await assert.rejects(pullHandoff(saved,other),/Sign in/);
  assert.equal(server.requests.length,afterExisting,'a token for another registry never reaches this server');
});

test('exchange scopes the registry token and a failed confirmation retries the same uploaded version', async () => {
  const sourceRepository = 'project/model', stagingRepository = 'project/uploads/slot';
  const fixture = pushRegistry({ repository: stagingRepository, accept: value => value === 'Bearer registry-only' });
  const registry = await startServer(fixture.handler);
  const source = { registry: registry.origin, repository: sourceRepository, digest: 'sha256:' + 'a'.repeat(64) };
  const handoff: OciHandoff = { protocol: HANDOFF_PROTOCOL, source, intent: 'edit', destination: { registry: registry.origin, repository: stagingRepository } };
  const scope = `repository:${stagingRepository}:pull repository:${stagingRepository}:push`;
  const tokenType = 'urn:ietf:params:oauth:token-type:access_token';
  const receipts: unknown[] = [];
  const outcomes = [
    { status: 503 },
    { status: 409 },
    { status: 201, receipt: { repository: 'project/unrelated' } },
    { status: 201, receipt: { digest: source.digest } },
    { status: 201 },
  ];
  const provider = await startServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/exchange') {
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'ifc-lite',
        resource: registry.origin,
        scope,
        subject_token: 'login-only',
        subject_token_type: tokenType,
        requested_token_type: tokenType,
      });
      return send(res, { body: JSON.stringify({ access_token: 'registry-only', token_type: 'Bearer', expires_in: 300, issued_token_type: tokenType, scope }) });
    }
    assert.equal(req.url, '/publications');
    assert.equal(req.headers.authorization, 'Bearer login-only');
    const payload = JSON.parse(body);
    receipts.push(payload);
    const outcome = outcomes.shift();
    assert(outcome);
    return send(res, { status: outcome.status, body: outcome.status === 201
      ? JSON.stringify({ ...source, digest: payload.uploaded.digest, ...outcome.receipt })
      : '' });
  });
  const settings = {
    endpoint: provider.origin + '/exchange',
    authorization_resource: provider.origin + '/files',
    read_scope: 'read',
    write_scope: 'read write',
    publication_endpoint: provider.origin + '/publications',
  };
  const configured = { ...connection, registry: registry.origin, token_exchange: settings };
  const [trusted] = registryConnections(JSON.stringify([configured]));
  assert.throws(() => registryConnections(JSON.stringify([{ ...configured, token_exchange: { ...settings, publication_endpoint: 'https://other.example.test/publications' } }])), /resource origin/);

  const signal = new AbortController().signal;
  const session = await exchangeRegistryToken(trusted, 'login-only', scope, signal);
  const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;');
  const uploaded = await pushHandoff(registry.origin, stagingRepository, 'save-1', bytes, 'edited.ifc', session, signal);
  const registryRequestCount = registry.requests.length;
  const confirm = () => confirmPublication(trusted, handoff, uploaded, 'login-only', signal);
  await assert.rejects(confirm(), /could not confirm the save/);
  await assert.rejects(confirm(), { status: 409 });
  // #9638: A 2xx may carry a valid locator for a different file or digest.
  await assert.rejects(confirm(), /different file or version/);
  await assert.rejects(confirm(), /different file or version/);
  assert.deepEqual(await confirm(), { ...source, digest: uploaded.digest });
  assert.equal(receipts.length, 5);
  for (const receipt of receipts) assert.deepEqual(receipt, { source, uploaded });
  assert.equal(registry.requests.length, registryRequestCount);
  const credentials = registry.requests.flatMap(request => request.authorization ? [request.authorization] : []);
  assert(credentials.length > 0 && credentials.every(value => value === 'Bearer registry-only'));
});
