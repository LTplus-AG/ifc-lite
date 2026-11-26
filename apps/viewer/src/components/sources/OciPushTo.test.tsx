/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { authorizeRepository, finishHandoff, prepareHandoff, resourceSession } from '@/lib/registry/handoff-auth';
import { pullHandoff } from '@/lib/registry/handoff-client';
import { HANDOFF_PROTOCOL, readHandoff, registryConnections, saveRegistryConnection } from '@/lib/registry/handoff-contract';
import { startServer, closeAll, send, type Handler } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { installRegistryPopup, registryCallback } from '@/test/registry-oauth-fixture';
import { useViewerStore } from '@/store';
import { OciPushTo } from './OciPushTo';
afterEach(async () => {
  cleanup();
  localStorage.clear();
  useHandoffWorkspace.setState(useHandoffWorkspace.getInitialState(), true);
  await closeAll();
});

function allowBrowser(handler: Handler): Handler {
  return (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', window.location.origin);
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Location,Docker-Content-Digest,Link');
    if (req.method === 'OPTIONS') return send(res, { status: 204 });
    return handler(req, res);
  };
}

function fileStoreForm(ui: HTMLElement, label: string) {
  const action = [...ui.querySelectorAll('button')].find(button => button.textContent === label);
  assert(action);
  click(action);
  const form = ui.querySelector('form');
  assert(form);
  return {
    fill(name: string, value: string) {
      const field = form.elements.namedItem(name);
      assert(field instanceof HTMLInputElement);
      type(field, value);
    },
    save() { act(() => form.requestSubmit()); },
  };
}

test('Push to publishes successive IFC versions and Browse reopens each pinned digest (#9638)', async () => {
  const model = await editedRegistryModel();
  const repository = 'project/model';
  const fixture = pushRegistry({ repository, accept: token => token === 'Bearer repository-token' });
  const next = '/v2/project/model/tags/list?last=model-v1';
  const registry = await startServer(allowBrowser((req, res) => {
    if (req.url === '/v2/project/model/tags/list' || req.url === next) {
      if (req.headers.authorization !== 'Bearer repository-token') return send(res, { status: 401 });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (req.url !== next) headers.Link = '<' + next + '>; rel="next"';
      const tags = req.url === next
        ? ['model-v2']
        : ['model-v1', ...Array.from({ length: 11 }, (_, i) => 'tag-that-disappeared-' + i)];
      return send(res, { headers, body: JSON.stringify({ name: repository, tags }) });
    }
    return fixture.handler(req, res);
  }));
  const scope = 'repository:project/model:pull repository:project/model:push';
  const session = resourceSession({
    access_token: 'repository-token', token_type: 'Bearer', expires_in: 300, scope,
  }, { registry: registry.origin, authorization_server: 'https://identity.example.test', client_id: 'ifc-lite' }, scope);
  useHandoffWorkspace.setState({ repositorySession: session });
  let ui = render(<OciPushTo onBusyChange={() => {}} />);
  const add = fileStoreForm(ui, 'Add file store');
  add.fill('registry', registry.origin + '/');
  add.fill('issuer', 'https://identity.example.test');
  add.fill('client', 'ifc-lite');
  add.save();
  assert.equal(ui.querySelector('form'), null);
  cleanup();
  ui = render(<OciPushTo onBusyChange={() => {}} />);
  const button = (label: string) => {
    const element = Array.from(ui.querySelectorAll('button')).find(button => button.textContent === label);
    assert(element, label);
    return element;
  };
  const field = (suffix: string) => {
    const element = ui.querySelector<HTMLInputElement>('input[id$="' + suffix + '"]');
    assert(element);
    return element;
  };
  const link = (label: string) => Array.from(ui.querySelectorAll('a')).find(anchor => anchor.textContent === label);
  async function openVersion(href: string) {
    const { source } = readHandoff(href);
    const received = await pullHandoff(source, session);
    const parsed = await model.parser.parseColumnar(received.bytes.buffer, { disableWorkerScan: true });
    return { source, name: parsed.entities.getName(model.wall) };
  }

  type(field('-folder'), repository);
  type(field('-version'), 'model-v1');
  click(button('Push to…'));
  await waitFor(() => Boolean(link('Open saved version')), 'the operation should complete');
  const first = link('Open saved version')!.href;
  assert.equal(readHandoff(first).source.digest, fixture.store.tags.get('model-v1'));
  assert.equal((await openVersion(first)).name, 'Registry persisted wall');

  await act(async () => {
    model.view.setAttribute(model.wall, 'Name', 'Second registry version');
    useViewerStore.setState(state => ({ mutationVersion: state.mutationVersion + 1 }));
  });
  type(field('-version'), 'model-v2');
  click(button('Push to…'));
  await waitFor(() => Boolean(link('Open saved version')), 'the operation should complete');
  const second = link('Open saved version')!.href;
  assert.notEqual(second, first);
  assert.equal((await openVersion(second)).name, 'Second registry version');
  assert.equal((await openVersion(first)).name, 'Registry persisted wall');

  const otherModel = fixtureModel('other-model', { idOffset: 1_000_000 });
  await act(async () => {
    useViewerStore.setState(state => ({
      activeModelId: otherModel.id, models: new Map(state.models).set(otherModel.id, otherModel),
    }));
  });
  assert.equal(link('Open saved version'), undefined);
  await act(async () => { useViewerStore.setState({ activeModelId: null, models: new Map() }); });
  assert.equal(button('Push to…').disabled, true);

  click(button('Browse versions'));
  await waitFor(() => Boolean(link('edited.ifc · model-v1')), 'the operation should complete');
  assert.equal(link('edited.ifc · model-v2'), undefined);
  click(button('More versions'));
  await waitFor(() => Boolean(link('edited.ifc · model-v2')), 'the operation should complete');
  const firstPublished = await openVersion(link('edited.ifc · model-v1')!.href);
  const secondPublished = await openVersion(link('edited.ifc · model-v2')!.href);
  assert.equal(firstPublished.source.digest, fixture.store.tags.get('model-v1'));
  assert.equal(secondPublished.source.digest, fixture.store.tags.get('model-v2'));
  assert.equal(firstPublished.name, 'Registry persisted wall');
  assert.equal(secondPublished.name, 'Second registry version');
  assert.equal(ui.querySelectorAll('a').length, 2);
  assert(registry.requests.some(request => request.url === next));
  assert(registry.requests.every(request => request.url !== '/v2/_catalog'));
});

test('browsing reauthorizes after the saved file store changes while Cloud Sources is closed (#9638)', async () => {
  const repository = 'project/model';
  const tagsPath = `/v2/${repository}/tags/list`;
  let origin = '';
  const server = await startServer(allowBrowser(async (req, res) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req.url === '/.well-known/oauth-authorization-server') {
      return send(res, { headers, body: JSON.stringify({
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      }) });
    }
    if (req.url === '/token') {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const client = new URLSearchParams(Buffer.concat(chunks).toString()).get('client_id');
      return send(res, { headers, body: JSON.stringify({ access_token: client, token_type: 'Bearer', expires_in: 300 }) });
    }
    assert.equal(req.url, tagsPath);
    if (!req.headers.authorization) return send(res, { status: 401 });
    return send(res, { headers, body: JSON.stringify({ name: repository, tags: [] }) });
  }));
  origin = server.origin;
  const connection = { registry: origin, authorization_server: origin, client_id: 'original-client' };
  saveRegistryConnection(connection);
  const popup = installRegistryPopup(registryCallback);

  async function browseFromReopenedPanel() {
    const ui = render(<OciPushTo onBusyChange={() => {}} />);
    const folder = ui.querySelector<HTMLInputElement>('input[id$="-folder"]');
    const browse = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Browse versions');
    assert(folder && browse);
    type(folder, repository);
    click(browse);
    await waitFor(() => browse.textContent !== 'Browse versions' || Boolean(ui.querySelector('[role=alert]')), 'the operation should complete');
    assert.equal(ui.querySelector('[role=alert]'), null);
    cleanup();
  }

  try {
    await browseFromReopenedPanel();
    await browseFromReopenedPanel();
    assert.equal(popup.opens(), 1, 'unchanged settings reuse the cached session');

    // Another tab writes to shared storage while this tab has no panel mounted.
    saveRegistryConnection({ ...connection, client_id: 'replacement-client' }, true);
    await browseFromReopenedPanel();
    const requests = server.requests.filter(request => request.url === tagsPath && request.authorization);
    assert.deepEqual(requests.map(request => request.authorization), [
      'Bearer original-client', 'Bearer original-client', 'Bearer replacement-client',
    ]);
    assert.equal(popup.opens(), 2);
  } finally {
    popup.restore();
  }
});

test('a grant for superseded file-store settings is neither cached nor used (#9638 review)', async () => {
  const repository = 'project/model';
  const tagsPath = `/v2/${repository}/tags/list`;
  let origin = '';
  const server = await startServer(allowBrowser(async (req, res) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req.url === '/.well-known/oauth-authorization-server') {
      return send(res, { headers, body: JSON.stringify({
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      }) });
    }
    if (req.url === '/token') {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const client = new URLSearchParams(Buffer.concat(chunks).toString()).get('client_id');
      return send(res, { headers, body: JSON.stringify({ access_token: client, token_type: 'Bearer', expires_in: 300 }) });
    }
    assert.equal(req.url, tagsPath);
    if (!req.headers.authorization) return send(res, { status: 401 });
    return send(res, { headers, body: JSON.stringify({ name: repository, tags: [] }) });
  }));
  origin = server.origin;
  const connection = { registry: origin, authorization_server: origin, client_id: 'original-client' };
  saveRegistryConnection(connection);
  // Another tab replaces the saved settings while this tab's sign-in popup is open.
  const popup = installRegistryPopup(request => {
    saveRegistryConnection({ ...connection, client_id: 'replacement-client' }, true);
    return registryCallback(request);
  });
  try {
    const ui = render(<OciPushTo onBusyChange={() => {}} />);
    const folder = ui.querySelector<HTMLInputElement>('input[id$="-folder"]');
    const browse = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Browse versions');
    assert(folder && browse);
    type(folder, repository);
    click(browse);
    await waitFor(() => Boolean(ui.querySelector('[role=alert]')), 'the operation should complete');
    assert.match(ui.querySelector('[role=alert]')!.textContent ?? '', /file-store settings changed/);
    assert.equal(server.requests.filter(request => request.url === tagsPath).length, 0);
    assert.equal(useHandoffWorkspace.getState().repositorySession, undefined);
  } finally {
    popup.restore();
  }
});

test('saving a file store never overwrites saved stores it cannot read (#9638 review)', () => {
  const unreadable = JSON.stringify([{ registry: 'https://kept.example.test', authorization_server: 'https://issuer.example.test' }]);
  localStorage.setItem('ifc-lite:oci-file-stores:v1', unreadable);
  assert.deepEqual(registryConnections(), []);
  assert.throws(() => saveRegistryConnection({ registry: 'https://new.example.test', authorization_server: 'https://issuer.example.test', client_id: 'ifc-lite' }), /could not be read/);
  assert.equal(localStorage.getItem('ifc-lite:oci-file-stores:v1'), unreadable);
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
  await assert.rejects(prepareHandoff(launch, signal), /Add this file store/);
  assert.equal(provider.requests.length, 0);
  const ui = render(<OciPushTo onBusyChange={() => {}} />);
  const add = fileStoreForm(ui, 'Add file store');
  add.fill('registry', origin);
  add.fill('issuer', 'http://issuer.example.test');
  add.fill('client', 'ifc-lite');
  add.save();
  assert.match(ui.querySelector('[role=alert]')?.textContent ?? '', /trusted HTTPS address/);
  assert.deepEqual(registryConnections(), []);
  add.fill('issuer', origin);
  add.save();
  assert.equal(ui.querySelector('form'), null);
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
      const handoffConnections = scenario.connections.length === 1 ? undefined : scenario.connections;
      const url = await prepareHandoff(launch, signal, handoffConnections);
      const opening = finishHandoff(callback(new URL(url)), signal, handoffConnections);
      const browsing = authorizeRepository(connection, source.repository, 'pull', signal, scenario.connections);
      const saving = authorizeRepository(connection, source.repository, 'push', signal, scenario.connections);
      if (scenario.succeeds) {
        const [opened, readSession, writeSession] = await Promise.all([opening, browsing, saving]);
        assert.deepEqual(opened.handoff, handoff);
        assert.equal(readSession.scope, 'repository:project/model:pull');
        assert.equal(writeSession.scope, 'repository:project/model:pull repository:project/model:push');
      } else {
        await Promise.all([
          assert.rejects(opening, /expected issuer/),
          assert.rejects(browsing, /expected issuer/),
          assert.rejects(saving, /expected issuer/),
        ]);
      }
    }

    const pending = await prepareHandoff(launch, signal);
    const edit = fileStoreForm(ui, 'Edit file store');
    edit.fill('client', 'replacement-client');
    edit.save();
    assert.equal(registryConnections()[0].client_id, 'replacement-client');
    await assert.rejects(finishHandoff(callback(new URL(pending)), signal), /configuration changed/);
  } finally {
    popup.restore();
  }
});
