/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { render, click, cleanup, waitFor } from '@/test/render';
import { skip, secondHook, blankFile } from '@/test/blank-ifc-loader-harness';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { registryTransport, clearRegistrySession, useRegistryWorkspace } from '@/lib/registry/workspace';
import { OCI_MANIFEST_TYPE, sha256 } from '@/lib/registry/artifacts';
import { RegistrySource } from './RegistrySource';

const originalFetch = globalThis.fetch;
afterEach(async () => {
  await act(async () => { cleanup(); clearRegistrySession(); useRegistryWorkspace.setState({ transport: null }); });
  globalThis.fetch = originalFetch;
});
function button(root: ParentNode, name: string) {
  const found = [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
  assert(found, `Missing ${name}`); return found;
}
async function fixture(context: TestContext) {
  const model = await editedRegistryModel();
  const blobDigest = await sha256(model.bytes);
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE,
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: await sha256(new TextEncoder().encode('{}')), size: 2 },
    layers: [{ mediaType: 'application/x-step', digest: blobDigest, size: model.bytes.length }] });
  const digest = await sha256(new TextEncoder().encode(manifest));
  const requests: string[] = []; const blobs = new Map<string, Uint8Array>(); const manifests = new Map<string, string>();
  let failRevoke = false; let metadataReads = 0;
  const wasmFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === 'file:') return wasmFetch(input, init);
    const method = init?.method ?? 'GET'; requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig('http://127.0.0.1:5000'));
    if (url.pathname === '/oauth/token') return Response.json(registryTokenReply());
    if (url.pathname === '/oauth/revoke') return new Response(null, { status: failRevoke ? 503 : 200 });
    if (url.pathname.endsWith('/tags/list')) return Response.json({ tags: ['issued'] });
    if (url.pathname.includes('/manifests/')) {
      if (method === 'HEAD') return new Response(null, { status: 404 });
      if (method === 'PUT') { assert(init?.body instanceof Uint8Array); manifests.set(url.pathname, new TextDecoder().decode(init.body)); return new Response(null, { status: 201 }); }
      if (url.pathname.endsWith('/issued')) return new Response(manifest);
      metadataReads++; return new Response(null, { status: 503 });
    }
    if (url.pathname.includes('/blobs/uploads/')) {
      if (method === 'POST') return new Response(null, { status: 202, headers: { Location: '/v2/project/model/blobs/uploads/upload' } });
      assert(init?.body instanceof Uint8Array); blobs.set(url.searchParams.get('digest')!, init.body); return new Response(null, { status: 201 });
    }
    if (method === 'HEAD') return new Response(null, { status: 404 });
    if (url.pathname.endsWith(blobDigest)) return new Response(model.bytes);
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };
  const popup = installRegistryPopup(registryCallback); context.after(popup.restore);
  const transport = registryTransport(window.location.origin); await transport.login(null);
  useRegistryWorkspace.setState({ models: ['project/model'], repository: 'project/model', release: 'issued',
    releases: [{ tag: 'issued', title: 'Model', digest }], tags: ['issued'], version: 'revision-2' });
  let ui!: HTMLElement;
  await act(async () => { ui = render(<><ConfirmDialogHost /><RegistrySource expanded navigationDisabled={false} onToggle={() => {}} onBusyChange={() => {}} /></>); });
  return { ...model, ui, transport, requests, blobs, manifests, digest, metadataReads: () => metadataReads, failRevoke: (value: boolean) => { failRevoke = value; } };
}

for (const count of [1, 2]) test(`opening a registry model requires consent before replacing ${count} edited model(s) (#8310)`, { skip }, async context => {
  const f = await fixture(context);
  if (count === 2) useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['peer', fixtureModel('peer')]]) });
  const before = useViewerStore.getState().models;
  click(button(f.ui, 'Open model'));
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'replacement must ask first');
  const dialog = document.querySelector('[role="alertdialog"]')!;
  assert.match(dialog.textContent ?? '', /all.*models.*unpublished edits/i);
  click(dialog.querySelector('button')!);
  await waitFor(() => !button(f.ui, 'Open model').disabled, 'cancelling releases the action');
  assert.equal(useViewerStore.getState().models, before);
  assert.equal(useViewerStore.getState().mutationViews.get(f.id), f.view);
  assert.equal(f.requests.some(path => path.includes('/manifests/')), false, 'cancelled open does not download');
  assert.equal(useRegistryWorkspace.getState().fingerprint, '');
});

for (const outcome of ['cancelled', 'superseded']) test(`a ${outcome} real registry load never records an opened fingerprint (#8310)`, { skip }, async context => {
  const f = await fixture(context);
  useViewerStore.getState().clearAllModels();
  const parse = IfcParser.prototype.parseColumnar;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let decoded = false; let calls = 0;
  context.mock.method(IfcParser.prototype, 'parseColumnar', async function (this: IfcParser, ...args: Parameters<typeof parse>) {
    const first = calls++ === 0;
    const store = await parse.apply(this, args);
    if (first) { decoded = true; await held; }
    return store;
  });
  click(button(f.ui, 'Open model'));
  try {
    await waitFor(() => decoded && Boolean(useViewerStore.getState().activeLoadCanceller), 'real metadata load is held');
    await act(async () => {
      if (outcome === 'cancelled') useViewerStore.getState().activeLoadCanceller?.();
      else { assert(secondHook); await secondHook.loadFile(blankFile('METRE')); }
    });
    release();
    await waitFor(() => !button(f.ui, 'Open model').disabled, 'cancelled load settles');
    assert.equal(useViewerStore.getState().error, null, 'cancellation carries no loader error');
    assert.equal(useRegistryWorkspace.getState().fingerprint, '');
    assert(!f.ui.textContent?.includes('Opened '));
    assert.match(f.ui.textContent ?? '', /not opened/i);
  } finally { release(); }
});

test('replacement consent cannot discard a session loaded during the download (#8310)', { skip }, async context => {
  const f = await fixture(context);
  const fetch = globalThis.fetch;
  let started = false; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/manifests/issued')) { started = true; await held; }
    return fetch(input, init);
  };
  click(button(f.ui, 'Open model'));
  try {
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'confirm outgoing session');
    click(button(document.querySelector('[role="alertdialog"]')!, 'Replace session'));
    await waitFor(() => started, 'registry download is in flight');
    await act(async () => { assert(secondHook); await secondHook.loadFile(blankFile('METRE')); });
    const replacement = useViewerStore.getState().models;
    release();
    await waitFor(() => !button(f.ui, 'Open model').disabled, 'stale download settles');
    assert.equal(useViewerStore.getState().models, replacement);
    assert.equal(useRegistryWorkspace.getState().fingerprint, '');
    assert.match(f.ui.textContent ?? '', /session changed/);
  } finally { release(); }
});

test('confirmed open records success only after its real model completes (#8310)', { skip }, async context => {
  const f = await fixture(context);
  click(button(f.ui, 'Open model'));
  await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'confirm replacement');
  click(button(document.querySelector('[role="alertdialog"]')!, 'Replace session'));
  await waitFor(() => Boolean(f.ui.textContent?.includes('Opened ')), 'real IFC load finishes');
  const state = useViewerStore.getState();
  assert.equal(state.models.get(state.activeModelId!)?.loadState, 'complete');
  assert.equal(state.models.has(f.id), false);
  assert.equal(useRegistryWorkspace.getState().fingerprint, f.digest);
});

test('committed publication remains successful when subsequent metadata is unavailable (#8310)', { skip }, async context => {
  const f = await fixture(context);
  click(button(f.ui, 'Publish edited model'));
  await waitFor(() => !button(f.ui, 'Publish edited model').disabled, 'publication settles');
  assert.equal(f.manifests.size, 1);
  const raw = [...f.manifests.values()][0];
  const manifest = JSON.parse(raw);
  const uploaded = f.blobs.get(manifest.layers[0].digest); assert(uploaded);
  const reopened = await f.parser.parseColumnar(new Uint8Array(uploaded).buffer, { disableWorkerScan: true });
  assert.equal(reopened.entities.getName(f.wall), 'Registry persisted wall');
  assert.match(f.ui.textContent ?? '', /Published revision-2/);
  assert.equal(useRegistryWorkspace.getState().published, await sha256(new TextEncoder().encode(raw)));
  assert(button(f.ui, 'Open saved version'));
  assert.equal(f.metadataReads(), 0, 'metadata refresh is separate from the committed write');
});

test('failed sign-out remains retryable after a later 401 and panel remount (#8310)', { skip }, async context => {
  const f = await fixture(context); f.failRevoke(true);
  click(button(f.ui, 'Sign out'));
  await waitFor(() => Boolean(f.ui.textContent?.includes('Please retry')), 'revoke fails');
  await act(async () => { await assert.rejects(f.transport.request('/v2/_catalog'), /expired/); });
  cleanup();
  let ui!: HTMLElement;
  await act(async () => { ui = render(<RegistrySource expanded navigationDisabled={false} onToggle={() => {}} onBusyChange={() => {}} />); });
  assert.equal(f.transport.can('pull'), false);
  assert.equal(ui.querySelector('form'), null, 'cannot start another login before revocation');
  f.failRevoke(false); click(button(ui, 'Retry sign out'));
  await waitFor(() => Boolean(ui.querySelector('form')), 'retry revokes the server session');
  assert.equal(f.requests.filter(path => path === 'POST /oauth/revoke').length, 2);
  await act(async () => { await f.transport.login(null); });
  assert(f.transport.can('pull'), 'the tab can connect again');
});
