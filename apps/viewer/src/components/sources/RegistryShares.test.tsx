/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { RegistryTransport } from '@/lib/registry/transport';
import { RegistryShares } from './RegistryShares';

const originalFetch = globalThis.fetch; const cleanups: (() => void)[] = [];
afterEach(async () => { await act(async () => cleanup()); cleanups.splice(0).reverse().forEach(f => f()); globalThis.fetch = originalFetch; });
function button(ui: HTMLElement, text: string) { const b = [...ui.querySelectorAll('button')].find(b => b.textContent === text); assert(b, `Missing ${text}`); return b; }

test('share controls default to a version snapshot with explicit expiry and revoke the created capability', async () => {
  const registry = 'http://127.0.0.1:5000'; const popup = installRegistryPopup(registryCallback); cleanups.push(popup.restore);
  const transport = new RegistryTransport(window.location.origin, registry); cleanups.push(() => transport.logout());
  let revoked = false; let created = false; const requests: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    if (path === '/oauth/token') return Response.json({ ...registryTokenReply(), authorization_type: 'session', permissions: [{ repositories: ['project/model'], actions: ['pull', 'push'] }], access: [{ type: 'registry', name: 'catalog', actions: ['read'] }] });
    if (path === '/shares/test-id/revoke') { revoked = true; return Response.json({ revoked: true }); }
    assert.equal(path, '/shares');
    if (init?.method === 'POST') { created = true; requests.push(JSON.parse(String(init.body))); return Response.json({ url: `${registry}/share#secret=${'a'.repeat(64)}` }); }
    return Response.json({ shares: created ? [{ id: 'abcd-1234', expires_at: Math.floor(Date.now() / 1000) + 86400, revoked }] : [] });
  };
  await transport.login(null);
  let pending = Promise.resolve(); let ui!: HTMLElement;
  await act(async () => { ui = render(<RegistryShares transport={transport} repository="project/model" tag="issued" busy={false} run={op => { pending = op(); }} />); });
  await act(async () => { click(button(ui, 'Manage shares')); await pending; });
  const mode = ui.querySelector('select'); assert(mode); assert.equal(mode.value, 'snapshot');
  await act(async () => { click(button(ui, 'Create share link')); await pending; });
  assert.deepEqual(requests, [{ version: 1, registry: '127.0.0.1:5000', grants: [{ repositories: ['project/model'], tags: ['issued'], actions: ['pull'] }], ttl: 86400, binding: 'snapshot' }]);
  const link = [...ui.querySelectorAll('input')].find(input => input.readOnly); assert(link?.value.includes('#secret='));
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/shares/abcd-1234/revoke') { revoked = true; return Response.json({ revoked: true }); }
    assert.equal(path, '/shares'); return Response.json({ shares: [{ id: 'abcd-1234', expires_at: Math.floor(Date.now() / 1000) + 86400, revoked }] });
  };
  await act(async () => { click(button(ui, 'Revoke')); await pending; });
  assert(revoked); assert(!ui.textContent?.includes('Copy share link')); assert(![...ui.querySelectorAll('input')].some(input => input.readOnly));
});
