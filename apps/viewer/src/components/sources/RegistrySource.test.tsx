/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, type, waitFor } from '@/test/render';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { clearRegistrySession, useRegistryWorkspace } from '@/lib/registry/workspace';
import { OCI_MANIFEST_TYPE, sha256 } from '@/lib/registry/artifacts';
import { SourcesPanel } from './SourcesPanel';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
const initialFetch = globalThis.fetch;

async function mount(enabled = true): Promise<HTMLElement> {
  let ui!: HTMLElement;
  await act(async () => { ui = render(<SourceHostProvider><SourcesPanel onClose={() => {}} registryEnabled={enabled} /></SourceHostProvider>); });
  return ui;
}
function button(ui: HTMLElement, name: string): HTMLButtonElement {
  const found = [...ui.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(name));
  assert(found, `Missing ${name} button`);
  return found;
}
afterEach(async () => { await act(async () => { cleanup(); clearRegistrySession(); }); globalThis.fetch = initialFetch; });

test('Model registry uses a registry sign-in action without viewer credentials (#8310)', async () => {
  const disabled = await mount(false);
  assert(!disabled.textContent?.includes('Model registry'));
  cleanup();
  globalThis.fetch = async input => new URL(String(input)).pathname === '/oauth/config'
    ? Response.json(registryOAuthConfig('http://127.0.0.1:5000')) : Response.json({ error: 'invalid_grant' }, { status: 401 });
  const ui = await mount();
  assert(ui.textContent?.includes('Dropbox'));
  assert(ui.textContent?.includes('Autodesk Forma / Data Exchange'));
  const entry = button(ui, 'Model registry');
  assert(entry.closest('ul > li'), 'registry belongs to the source connection list');
  assert.equal(entry.getAttribute('aria-expanded'), 'false');
  click(entry);
  assert.equal(entry.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.querySelector('input[type="password"]'), null);
  assert.equal(ui.querySelector('input[autocomplete="username"]'), null);
  assert(button(ui, 'Sign in to ifcx-oci'));
  click(entry);
  assert.equal(ui.querySelector('fieldset')?.hidden, true);
});

test('closing and reopening Cloud Sources preserves the connection; explicit sign-out clears it', async () => {
  const originalFetch = globalThis.fetch;
  const popup = installRegistryPopup(registryCallback);
  let signIns = 0;
  const raw = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${'a'.repeat(64)}`, size: 2 }, layers: [], annotations: { 'org.opencontainers.image.title': 'Sample building', 'org.opencontainers.image.authors': 'Declared designer' } });
  const digest = await sha256(new TextEncoder().encode(raw));
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert(!new Headers(init?.headers).has('Authorization') || url.pathname.startsWith('/v2/'));
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig('http://127.0.0.1:5000'));
    if (url.pathname === '/oauth/token') {
      assert.equal(init?.method, 'POST');
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'refresh_token') return Response.json({ error: 'invalid_grant' }, { status: 401 });
      signIns += 1;
      assert(body.get('code_verifier')); assert.equal(body.has('password'), false);
      return Response.json(registryTokenReply());
    }
    if (url.pathname === '/oauth/revoke') return new Response(null, { status: 200 });
    if (url.pathname === '/v2/_catalog') return Response.json({ repositories: ['project/model'] });
    if (url.pathname === '/v2/project/model/manifests/issued') return new Response(raw, { headers: { 'Docker-Content-Digest': digest, 'ifcx-registry-publisher': 'writer', 'ifcx-registry-pushed-at': '1793136000' } });
    if (url.pathname === '/v2/project/model/tags/list') return Response.json({ tags: ['issued'] });
    throw new Error(`Unexpected registry request ${url.pathname}`);
  };
  try {
    let ui = await mount(); click(button(ui, 'Model registry'));
    const address = ui.querySelector<HTMLInputElement>('input[autocomplete="off"]'); assert(address); type(address, 'http://localhost:5000/project/model:issued');
    const form = ui.querySelector('form'); assert(form);
    act(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await waitFor(() => Boolean(ui.textContent?.includes('Can publish')), 'registry login should finish');
    const transport = useRegistryWorkspace.getState().transport; assert(transport); assert(transport.can('push'));
    cleanup();
    ui = await mount(); click(button(ui, 'Model registry'));
    assert(ui.textContent?.includes('Can publish'), 'connection survives the panel unmount');
    assert.equal(ui.querySelector('input[type="password"]'), null);
    assert.equal(signIns, 1, 'reopening does not ask for a second token');
    assert(ui.textContent?.includes('Published by writer'));
    const details = ui.querySelector('details'); assert(details); assert.equal(details.open, false, 'full fingerprints are collapsed');
    assert.equal(ui.querySelector<HTMLSelectElement>('select')?.selectedOptions[0]?.textContent, 'Sample building');
    click(button(ui, 'Sign out'));
    await waitFor(() => useRegistryWorkspace.getState().session === null, 'server revocation should complete sign-out');
    assert.equal(useRegistryWorkspace.getState().session, null);
    assert.equal(transport.can('pull'), false);
    assert.equal(ui.querySelector('input[type="password"]'), null);
    assert(button(ui, 'Sign in to ifcx-oci'));
    assert.equal(popup.opens(), 1); assert.deepEqual(popup.errors, []);
  } finally { globalThis.fetch = originalFetch; popup.restore(); }
});

test('remembered login restores the source after a fresh viewer mount without opening a popup (#8310)', async () => {
  const originalFetch = globalThis.fetch; const originalOpen = window.open;
  let remembered = true; let restores = 0;
  const raw = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE,
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${'a'.repeat(64)}`, size: 2 }, layers: [],
    annotations: { 'org.opencontainers.image.title': 'Remembered building' } });
  const digest = await sha256(new TextEncoder().encode(raw));
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig('http://127.0.0.1:5000'));
    if (url.pathname === '/oauth/token') {
      restores++;
      const body = new URLSearchParams(String(init?.body)); assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.has('refresh_token'), false);
      assert.equal(init?.credentials, 'include');
      return remembered ? Response.json(registryTokenReply('writer', ['pull', 'push'], true)) : Response.json({ error: 'invalid_grant' }, { status: 401 });
    }
    if (url.pathname === '/oauth/revoke') { remembered = false; return new Response(null, { status: 200 }); }
    if (url.pathname === '/v2/_catalog') return Response.json({ repositories: ['project/model'] });
    if (url.pathname.endsWith('/tags/list')) return Response.json({ tags: ['issued'] });
    if (url.pathname.endsWith('/manifests/issued')) return new Response(raw, { headers: { 'Docker-Content-Digest': digest } });
    throw new Error(`Unexpected remembered registry request ${url.pathname}`);
  };
  window.open = () => { throw new Error('Remembered restoration must not open a popup'); };
  const freshPage = () => { clearRegistrySession(); useRegistryWorkspace.setState({ transport: null }); };
  try {
    freshPage(); let ui = await mount(); click(button(ui, 'Model registry'));
    await waitFor(() => Boolean(ui.textContent?.includes('Can publish')), 'remembered session should restore and browse');
    assert(ui.textContent?.includes('Remembered building')); assert.equal(ui.querySelector('input[type="password"]'), null);
    cleanup(); freshPage(); ui = await mount(); click(button(ui, 'Model registry'));
    await waitFor(() => Boolean(ui.textContent?.includes('Can publish')), 'a reloaded viewer should restore again');
    assert.equal(restores, 2);
    click(button(ui, 'Sign out'));
    await waitFor(() => useRegistryWorkspace.getState().session === null, 'remembered sign-out should finish');
    cleanup(); freshPage(); ui = await mount(); click(button(ui, 'Model registry'));
    await waitFor(() => restores === 3, 'fresh viewer should check the cleared cookie');
    assert(button(ui, 'Sign in to ifcx-oci')); assert.equal(useRegistryWorkspace.getState().session, null);
  } finally { globalThis.fetch = originalFetch; window.open = originalOpen; }
});
