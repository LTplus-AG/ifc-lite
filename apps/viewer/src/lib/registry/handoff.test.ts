/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { startServer, closeAll } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { handoffContext, readHandoff, HANDOFF_PROTOCOL } from './handoff-contract';
import { resourceSession } from './handoff-auth';
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
