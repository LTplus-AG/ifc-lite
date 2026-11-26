/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { startServer, closeAll, send } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { handoffContext, readHandoff, registryConnections, HANDOFF_PROTOCOL } from './handoff-contract';
import { exchangeRegistryToken, resourceAllows, resourceSession } from './handoff-auth';
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
  const session=resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'repository:project/model:pull'},connection,requested);
  assert.equal(session.scope,'repository:project/model:pull');
  assert.throws(() => resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'repository:other/model:pull'},connection,requested));
});

test('identity scopes an issuer adds by default do not block a repository grant (#9638 review)', () => {
  const requested='repository:project/model:pull';
  // Keycloak returns its default client scopes alongside the requested ones.
  const session=resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'profile email repository:project/model:pull'},connection,requested);
  assert(resourceAllows(session,'project/model','pull'));
  assert.equal(resourceAllows(session,'project/model','push'),false);
  assert.throws(() => resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'profile email'},connection,requested),/exceeds/);
  assert.throws(() => resourceSession({access_token:'opaque',token_type:'Bearer',expires_in:300,scope:'profile repository:project/model:delete'},connection,requested),/unsupported/);
});

test('push and pull use OCI and isolate source/destination tokens at the actual HTTP boundary', async () => {
  const fixture=pushRegistry({repository:'project/model',accept:authorization => authorization==='Bearer destination'});
  const server=await startServer(fixture.handler), scope='repository:project/model:pull,push';
  const session=resourceSession({access_token:'destination',token_type:'Bearer',expires_in:300,scope},{...connection,registry:server.origin},scope);
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

test('token exchange scopes direct OCI publication to the configured repository (#9638)', async () => {
  const repository = 'project/model';
  const fixture = pushRegistry({ repository, accept: value => value === 'Bearer registry-only' });
  const registry = await startServer(fixture.handler);
  const scope = 'repository:project/model:pull repository:project/model:push';
  const tokenType = 'urn:ietf:params:oauth:token-type:access_token';
  const provider = await startServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/exchange');
    assert.equal(req.headers.authorization, undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())), {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'ifc-lite',
      resource: registry.origin,
      scope,
      subject_token: 'login-only',
      subject_token_type: tokenType,
      requested_token_type: tokenType,
    });
    return send(res, { body: JSON.stringify({
      access_token: 'registry-only', token_type: 'Bearer', expires_in: 300, issued_token_type: tokenType, scope,
    }) });
  });
  const settings = {
    endpoint: provider.origin + '/exchange',
    authorization_resource: provider.origin + '/files',
    read_scope: 'read',
    write_scope: 'read write',
  };
  const configured = { ...connection, registry: registry.origin, token_exchange: settings };
  const [trusted] = registryConnections(JSON.stringify([configured]));
  assert.throws(() => registryConnections(JSON.stringify([{
    ...configured, token_exchange: { ...settings, endpoint: 'https://other.example.test/exchange' },
  }])), /resource origin/);

  const signal = new AbortController().signal;
  const session = await exchangeRegistryToken(trusted, 'login-only', scope, signal);
  const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;');
  const uploaded = await pushHandoff(registry.origin, repository, 'model-v1', bytes, 'edited.ifc', session, signal);
  assert.deepEqual((await pullHandoff(uploaded, session, signal)).bytes, bytes);
  assert.equal(fixture.store.tags.get('model-v1'), uploaded.digest);
  const credentials = registry.requests.flatMap(request => request.authorization ? [request.authorization] : []);
  assert(credentials.length > 0 && credentials.every(value => value === 'Bearer registry-only'));
});
