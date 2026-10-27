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
function field(ui: HTMLElement, selector: string): HTMLInputElement {
  const found = ui.querySelector<HTMLInputElement>(selector);
  assert(found, `Missing ${selector} input`);
  return found;
}

afterEach(async () => { await act(async () => { cleanup(); clearRegistrySession(); }); });

test('Model registry is opt-in and uses the Cloud Sources connection list', async () => {
  const disabled = await mount(false);
  assert(!disabled.textContent?.includes('Model registry'));
  cleanup();
  const ui = await mount();
  assert(ui.textContent?.includes('Dropbox'));
  assert(ui.textContent?.includes('Autodesk Forma / Data Exchange'));
  const entry = button(ui, 'Model registry');
  assert(entry.closest('ul > li'), 'registry belongs to the source connection list');
  assert.equal(entry.getAttribute('aria-expanded'), 'false');
  click(entry);
  assert.equal(entry.getAttribute('aria-expanded'), 'true');
  const password = field(ui, 'input[type="password"]');
  type(password, 'temporary-test-secret');
  click(entry);
  assert.equal(password.value, '', 'collapsing the source clears an unsubmitted password');
  assert.equal(password.closest('fieldset')?.hidden, true);
});

test('closing and reopening Cloud Sources preserves the connection; explicit sign-out clears it', async () => {
  const originalFetch = globalThis.fetch;
  let signIns = 0;
  const raw = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${'a'.repeat(64)}`, size: 2 }, layers: [], annotations: { 'org.opencontainers.image.title': 'Sample building', 'org.opencontainers.image.authors': 'Declared designer' } });
  const digest = await sha256(new TextEncoder().encode(raw));
  globalThis.fetch = async input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/v2/') return new Response(null, { status: 401, headers: {
      'WWW-Authenticate': `Bearer realm="${window.location.origin}/token",service="registry-test"`,
    } });
    if (url.pathname === '/token') {
      signIns += 1;
      return Response.json({ token: 'test-session-only', expires_in: 900,
        subject: 'writer', access: [{ type: 'registry', name: 'catalog', actions: ['read'] }, { type: 'repository', name: 'project/model', actions: ['pull', 'push'] }] });
    }
    if (url.pathname === '/v2/_catalog') return Response.json({ repositories: ['project/model'] });
    if (url.pathname === '/v2/project/model/manifests/issued') return new Response(raw, { headers: { 'Docker-Content-Digest': digest, 'ifcx-registry-publisher': 'writer', 'ifcx-registry-pushed-at': '1793136000' } });
    if (url.pathname === '/v2/project/model/tags/list') return Response.json({ tags: ['issued'] });
    throw new Error(`Unexpected registry request ${url.pathname}`);
  };
  try {
    let ui = await mount(); click(button(ui, 'Model registry'));
    type(field(ui, 'input[autocomplete="username"]'), 'writer');
    const address = ui.querySelector<HTMLInputElement>('input[autocomplete="off"]'); assert(address); type(address, 'http://localhost:5000/project/model:issued');
    type(field(ui, 'input[type="password"]'), 'test-password');
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
    assert.equal(useRegistryWorkspace.getState().session, null);
    assert.equal(transport.can('pull'), false);
    assert.equal(field(ui, 'input[type="password"]').value, '');
  } finally { globalThis.fetch = originalFetch; }
});
