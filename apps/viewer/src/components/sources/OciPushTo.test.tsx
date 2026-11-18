/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { registerEnglish } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { resourceSession } from '@/lib/registry/handoff-auth';
import { startServer, closeAll, send, type Handler } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { installRegistryPopup, registryCallback } from '@/test/registry-oauth-fixture';
import { useViewerStore } from '@/store';
import { OciPushTo } from './OciPushTo';
registerEnglish(registryEn);
afterEach(async () => { cleanup(); useHandoffWorkspace.setState({ handoff:undefined, sourceSession:undefined, destinationSession:undefined, pendingPublication:undefined, saved:undefined, loadedModelId:undefined }); await closeAll(); });
async function waitFor(predicate: () => boolean) { for (let i=0;i<100;i++) { if (predicate()) return; await act(async () => { await new Promise(r => setTimeout(r,10)); }); } assert(predicate(),'operation should complete'); }

test('Push to publishes a real edited model without any preceding launch and returns a pinned reopen link', async () => {
  const model=await editedRegistryModel(), fixture=pushRegistry({repository:'project/model',accept:a => a==='Bearer destination-only'}), server=await startServer((req,res) => { res.setHeader('Access-Control-Allow-Origin',window.location.origin); res.setHeader('Access-Control-Allow-Headers','authorization,content-type'); res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,OPTIONS'); res.setHeader('Access-Control-Expose-Headers','Location,Docker-Content-Digest'); if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; } return fixture.handler(req,res); });
  const scope='repository:project/model:pull repository:project/model:push';
  useHandoffWorkspace.setState({destinationSession:resourceSession({access_token:'destination-only',token_type:'Bearer',expires_in:300,scope},server.origin,scope)});
  const ui=render(<OciPushTo connections={[{registry:server.origin,authorization_server:'https://identity.example.test',client_id:'ifc-lite'}]} onBusyChange={() => {}} />);
  const button=Array.from(ui.querySelectorAll('button')).find(b => b.textContent==='Push to…');assert(button);click(button);
  await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
  const saved=useHandoffWorkspace.getState().saved!;
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
});

test('Save new version retries confirmation without republishing the edited IFC', async () => {
  await editedRegistryModel();
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
  const publications: unknown[] = [];
  const issuedTokenType = 'urn:ietf:params:oauth:token-type:access_token';
  let providerOrigin = '';
  const provider = await startServer(cors(async (req, res) => {
    function reply(status: number, value: unknown) {
      return send(res, { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      return reply(200, { issuer: providerOrigin, authorization_endpoint: providerOrigin + '/authorize', token_endpoint: providerOrigin + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
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
      const fields = new URLSearchParams(body);
      assert.equal(fields.get('subject_token'), 'user-token');
      assert.equal(fields.get('scope'), scope);
      return reply(200, { access_token: 'staging-token', token_type: 'Bearer', expires_in: 300, issued_token_type: issuedTokenType, scope });
    }
    assert.equal(req.url, '/publications');
    assert.equal(req.headers.authorization, 'Bearer user-token');
    const payload = JSON.parse(body);
    assert.deepEqual(payload.source, source);
    assert.equal(payload.uploaded.repository, staging);
    assert(fixture.store.manifests.has(payload.uploaded.digest));
    publications.push(payload);
    return publications.length === 1
      ? reply(503, {})
      : reply(201, { ...source, digest: payload.uploaded.digest });
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
    function button(text: string) {
      const item = Array.from(ui.querySelectorAll('button')).find(b => b.textContent === text);
      assert(item);
      return item;
    }
    click(button('Save new version'));
    await waitFor(() => Boolean(ui.querySelector('[role=alert]')));
    assert.equal(useHandoffWorkspace.getState().saved, undefined);
    const uploaded = useHandoffWorkspace.getState().pendingPublication?.artifact;
    assert(uploaded);
    const beforeRetry = registry.requests.length;
    click(button('Finish saving uploaded version'));
    await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
    assert.deepEqual(useHandoffWorkspace.getState().saved, { ...source, digest: uploaded.digest });
    assert.equal(registry.requests.length, beforeRetry);
    assert.deepEqual(publications, [{ source, uploaded }, { source, uploaded }]);
    assert.deepEqual(popup.errors, []);
  } finally {
    popup.restore();
  }
});
