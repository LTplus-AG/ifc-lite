/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { registerEnglish } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { authorizeDestination, finishHandoff, prepareHandoff, resourceSession } from '@/lib/registry/handoff-auth';
import { pullHandoff } from '@/lib/registry/handoff-client';
import { HANDOFF_PROTOCOL } from '@/lib/registry/handoff-contract';
import { startServer, closeAll, send, type Handler } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { installRegistryPopup, registryCallback } from '@/test/registry-oauth-fixture';
import { useViewerStore } from '@/store';
import { OciPushTo } from './OciPushTo';
registerEnglish(registryEn);
afterEach(async () => {
  cleanup();
  useHandoffWorkspace.setState(useHandoffWorkspace.getInitialState(), true);
  await closeAll();
});
async function waitFor(predicate: () => boolean) { for (let i=0;i<100;i++) { if (predicate()) return; await act(async () => { await new Promise(r => setTimeout(r,10)); }); } assert(predicate(),'operation should complete'); }

test('Push to publishes a real edited model without any preceding launch and returns a pinned reopen link', async () => {
  const model=await editedRegistryModel(), fixture=pushRegistry({repository:'project/model',accept:a => a==='Bearer destination-only'}), server=await startServer((req,res) => { res.setHeader('Access-Control-Allow-Origin',window.location.origin); res.setHeader('Access-Control-Allow-Headers','authorization,content-type'); res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,OPTIONS'); res.setHeader('Access-Control-Expose-Headers','Location,Docker-Content-Digest'); if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; } return fixture.handler(req,res); });
  const scope='repository:project/model:pull repository:project/model:push';
  useHandoffWorkspace.setState({destinationSession:resourceSession({access_token:'destination-only',token_type:'Bearer',expires_in:300,scope},server.origin,scope)});
  const managedRegistry = 'https://managed.example.test';
  const issuer = 'https://identity.example.test';
  const ui=render(<OciPushTo connections={[
    {registry:server.origin,authorization_server:issuer,client_id:'ifc-lite'},
    {registry:managedRegistry,authorization_server:issuer,client_id:'ifc-lite',token_exchange:{
      endpoint: issuer + '/exchange', publication_endpoint: issuer + '/publications',
      authorization_resource: issuer + '/files', read_scope: 'read', write_scope: 'write',
    }},
  ]} onBusyChange={() => {}} />);
  const button=Array.from(ui.querySelectorAll('button')).find(b => b.textContent==='Push to…');assert(button);click(button);
  await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
  const saved=useHandoffWorkspace.getState().saved!.artifact;
  assert.equal(saved.registry,server.origin);
  const manifest=fixture.store.manifests.get(saved.digest);assert(manifest);
  const descriptor=JSON.parse(new TextDecoder().decode(manifest.bytes)).layers[0];
  const bytes=fixture.store.blobs.get(descriptor.digest);assert(bytes);
  const reopened=await model.parser.parseColumnar(new Uint8Array(bytes).buffer,{disableWorkerScan:true});
  assert.equal(reopened.entities.getName(model.wall),'Registry persisted wall');
  const link=ui.querySelector('a');assert(link);
  const encoded=new URL(link.href).hash.slice('#handoff='.length);
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64url').toString()).source,saved);
  assert(server.requests.filter(r => r.authorization).every(r => r.authorization==='Bearer destination-only'));

  // #9638: A registry save belonging to another active model must be hidden.
  const managed = fixtureModel('managed-model', { idOffset: 1_000_000 });
  await act(async () => {
    useHandoffWorkspace.setState({
      loadedModelId: managed.id,
      handoff: {
        protocol: HANDOFF_PROTOCOL, intent: 'edit',
        source: { registry: managedRegistry, repository: 'other/model', digest: saved.digest },
        destination: { registry: managedRegistry, repository: 'other/uploads/slot' },
      },
    });
    useViewerStore.setState(state => ({
      activeModelId: managed.id, models: new Map(state.models).set(managed.id, managed),
    }));
  });
  assert.equal(ui.querySelector('a'), null);
  assert(Array.from(ui.querySelectorAll('button')).some(b => b.textContent === 'Save new version'));
});

test('managed save retries a staged snapshot, advances the base, and requires reopening after a conflict (#9638)', async () => {
  const model = await editedRegistryModel();
  const modelId = useViewerStore.getState().activeModelId;
  assert(modelId);
  const cors = (handler: Handler): Handler => (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', window.location.origin);
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Location,Docker-Content-Digest');
    if (req.method === 'OPTIONS') return send(res, { status: 204 });
    return handler(req, res);
  };

  const staging = 'project/uploads/slot', sourceRepo = 'project/model';
  const fixture = pushRegistry({ repository: staging, accept: value => value === 'Bearer staging-token' });
  const registry = await startServer(cors(fixture.handler));
  const source = { registry: registry.origin, repository: sourceRepo, digest: 'sha256:' + 'a'.repeat(64) };
  const destination = { registry: registry.origin, repository: staging };
  const scope = `repository:${staging}:pull repository:${staging}:push`;
  const publications: { source: typeof source; uploaded: typeof source }[] = [];
  let exchangeCount = 0;
  const issuedTokenType = 'urn:ietf:params:oauth:token-type:access_token';
  let providerOrigin = '';
  const provider = await startServer(cors(async (req, res) => {
    function reply(status: number, value: unknown) {
      return send(res, { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      return reply(200, { issuer: providerOrigin, authorization_endpoint: providerOrigin + '/authorize', token_endpoint: providerOrigin + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/token') {
      const fields = new URLSearchParams(body);
      assert.equal(fields.get('code'), 'test-code');
      assert.match(fields.get('code_verifier') ?? '', /^[A-Za-z0-9._~-]{43,128}$/);
      assert.equal(fields.get('resource'), providerOrigin + '/files');
      return reply(200, { access_token: 'user-token', token_type: 'Bearer', expires_in: 300 });
    }
    if (req.url === '/exchange') {
      exchangeCount++;
      if (publications.length === 1) return reply(403, {});
      const fields = new URLSearchParams(body);
      assert.equal(fields.get('subject_token'), 'user-token');
      assert.equal(fields.get('scope'), scope);
      return reply(200, { access_token: 'staging-token', token_type: 'Bearer', expires_in: 300, issued_token_type: issuedTokenType, scope });
    }
    assert.equal(req.url, '/publications');
    assert.equal(req.headers.authorization, 'Bearer user-token');
    const payload = JSON.parse(body);
    assert.equal(payload.uploaded.repository, staging);
    assert(fixture.store.manifests.has(payload.uploaded.digest));
    publications.push(payload);
    if (publications.length === 1) return reply(503, {});
    if (publications.length === 4) return reply(409, {});
    return reply(201, { ...source, digest: payload.uploaded.digest });
  }));
  providerOrigin = provider.origin;
  const popup = installRegistryPopup(request => {
    assert.equal(request.searchParams.get('scope'), 'openid read write');
    assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(registryCallback(request));
    callback.searchParams.set('iss', provider.origin);
    return callback.href;
  });
  try {
    useHandoffWorkspace.setState({ handoff: { protocol: 'oci-handoff/1', intent: 'edit', source, destination }, loadedModelId: modelId });
    const ui = render(<OciPushTo connections={[{
      registry: registry.origin, authorization_server: provider.origin, client_id: 'ifc-lite',
      token_exchange: { endpoint: provider.origin + '/exchange', publication_endpoint: provider.origin + '/publications',
        authorization_resource: provider.origin + '/files', read_scope: 'openid read', write_scope: 'openid read write' },
    }]} onBusyChange={() => {}} />);
    const button = (text: string) => {
      const item = Array.from(ui.querySelectorAll('button')).find(b => b.textContent === text);
      assert(item);
      return item;
    };
    click(button('Save new version'));
    await waitFor(() => Boolean(ui.querySelector('[role=alert]')));
    assert.equal(useHandoffWorkspace.getState().saved, undefined);
    assert.match(ui.textContent ?? '', /confirms the earlier upload/);
    const uploaded = useHandoffWorkspace.getState().pendingPublication?.artifact;
    assert(uploaded);
    await act(async () => {
      model.view.setAttribute(model.wall, 'Name', 'Edited after the first upload');
      useViewerStore.setState(state => ({ mutationVersion: state.mutationVersion + 1 }));
    });
    const beforeRetry = registry.requests.length;
    click(button('Finish saving uploaded version'));
    await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
    const first = { ...source, digest: uploaded.digest };
    assert.deepEqual(useHandoffWorkspace.getState().saved?.artifact, first);
    assert.equal(registry.requests.length, beforeRetry);
    assert.equal(exchangeCount, 1);
    assert.deepEqual(publications, [{ source, uploaded }, { source, uploaded }]);

    click(button('Save new version'));
    await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
    const second = useHandoffWorkspace.getState().saved?.artifact;
    assert(second);
    assert.notEqual(second.digest, first.digest);
    assert.deepEqual(publications[2].source, first);
    assert.equal(publications[2].uploaded.digest, second.digest);
    const stagingSession = resourceSession({
      access_token: 'staging-token', token_type: 'Bearer', expires_in: 300, scope,
    }, registry.origin, scope);
    const later = await pullHandoff(publications[2].uploaded, stagingSession);
    const parsed = await model.parser.parseColumnar(later.bytes.buffer, { disableWorkerScan: true });
    assert.equal(parsed.entities.getName(model.wall), 'Edited after the first upload');

    click(button('Save new version'));
    await waitFor(() => Boolean(ui.querySelector('[role=alert]')));
    assert.deepEqual(publications[3].source, second);
    assert.match(ui.querySelector('[role=alert]')?.textContent ?? '', /Open it for editing from the file store/);
    assert.equal(useHandoffWorkspace.getState().pendingPublication, undefined);
    assert.equal(useHandoffWorkspace.getState().saved, undefined);
    assert.equal(ui.querySelector('button'), null);
    assert.deepEqual(popup.errors, []);
  } finally {
    popup.restore();
  }
});

test('OCI handoff requires callback issuer identification when advertised or when multiple issuers share the callback (#9638)', async () => {
  let origin = '';
  let advertisesIssuer = false;
  const provider = await startServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': window.location.origin };
    if (req.url === '/.well-known/oauth-authorization-server') {
      return send(res, { headers, body: JSON.stringify({
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        ...(advertisesIssuer && { authorization_response_iss_parameter_supported: true }),
      }) });
    }
    assert.equal(req.url, '/token');
    return send(res, { headers, body: JSON.stringify({ access_token: 'token', token_type: 'Bearer', expires_in: 300 }) });
  });
  origin = provider.origin;
  const connection = { registry: origin, authorization_server: origin, client_id: 'ifc-lite' };
  const other = { ...connection, registry: 'https://other.example.test', authorization_server: 'https://issuer.example.test' };
  const source = { registry: origin, repository: 'project/model', digest: 'sha256:' + 'a'.repeat(64) };
  const handoff = { protocol: HANDOFF_PROTOCOL, source, intent: 'edit' };
  const launch = window.location.origin + '/open-artifact#handoff=' + Buffer.from(JSON.stringify(handoff)).toString('base64url');
  const signal = new AbortController().signal;
  let callbackIssuer: string | undefined;
  function callback(request: URL) {
    const url = new URL(registryCallback(request));
    if (callbackIssuer) url.searchParams.set('iss', callbackIssuer);
    return url.href;
  }
  const popup = installRegistryPopup(callback);
  try {
    for (const scenario of [
      { advertise: false, connections: [connection], issuer: undefined, succeeds: true },
      { advertise: false, connections: [connection], issuer: other.authorization_server, succeeds: false },
      { advertise: true, connections: [connection], issuer: undefined, succeeds: false },
      { advertise: false, connections: [connection, other], issuer: undefined, succeeds: false },
      { advertise: false, connections: [connection, other], issuer: origin, succeeds: true },
    ]) {
      advertisesIssuer = scenario.advertise;
      callbackIssuer = scenario.issuer;
      const url = await prepareHandoff(launch, signal, scenario.connections);
      const opening = finishHandoff(callback(new URL(url)), signal, scenario.connections);
      const saving = authorizeDestination(connection, source.repository, signal, scenario.connections);
      if (scenario.succeeds) {
        assert.deepEqual((await opening).handoff, handoff);
        assert.equal((await saving).session.scope, 'repository:project/model:pull repository:project/model:push');
      } else {
        await Promise.all([
          assert.rejects(opening, /expected issuer/),
          assert.rejects(saving, /expected issuer/),
        ]);
      }
    }
  } finally {
    popup.restore();
  }
});
