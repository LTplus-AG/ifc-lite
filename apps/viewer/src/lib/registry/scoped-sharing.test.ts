/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { ScopedTokens } from './scoped-tokens';
import { RegistryTransport } from './transport';
import { grantAllows, parseGrants, repositoryMatches } from './grants';
import { parseRegistryAddress } from './connection';

const registry = 'http://127.0.0.1:5000'; const originalFetch = globalThis.fetch; const cleanup: (() => void)[] = [];
afterEach(() => { globalThis.fetch = originalFetch; cleanup.splice(0).reverse().forEach(f => f()); });
const urlOf = (input: Parameters<typeof fetch>[0]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
function rootReply() { return { ...registryTokenReply(), authorization_type: 'session', permissions: [{ repositories: ['hospital-a/**'], tags: ['review-*', 'issued'], actions: ['pull', 'push'] }], access: [{ type: 'registry', name: 'catalog', actions: ['read'] }] }; }
function client() { const c = new RegistryTransport(window.location.origin, registry); cleanup.push(() => c.logout()); return c; }

test('grant matching preserves project boundaries, nested patterns, tags, and explicit actions', () => {
  for (const [pattern, repo, expected] of [['hospital-a/**', 'hospital-a', false], ['hospital-a/**', 'hospital-a/models/architecture', true], ['hospital-a/**/*', 'hospital-a/model', true], ['hospital-a/*/*', 'hospital-a/models/nested/model', false], ['hospital-a/**', 'hospital-ab/model', false]] as const) assert.equal(repositoryMatches(pattern, repo), expected);
  const rules = parseGrants([{ repositories: ['hospital-a/**'], tags: ['issued'], actions: ['pull'] }]);
  assert(grantAllows(rules, 'hospital-a/models/architecture', 'pull', 'issued'));
  assert(!grantAllows(rules, 'hospital-a/models/architecture', 'pull', 'draft'));
  assert(!grantAllows(rules, 'hospital-a/models/architecture', 'push', 'issued'));
  assert.throws(() => parseGrants([{ repositories: [], actions: ['pull'] }]));
});

test('one approval exchanges and coalesces concrete tokens; root never accompanies artifact requests', async () => {
  const popup = installRegistryPopup(registryCallback); cleanup.push(popup.restore); const c = client(); let exchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    if (url.pathname === '/oauth/token') return Response.json(rootReply());
    if (url.pathname === '/token') {
      exchanges++; assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-session-only');
      const repo = url.searchParams.get('scope')!.split(':')[1];
      await new Promise(resolve => setImmediate(resolve));
      return Response.json({ access_token: `resource:${repo}`, expires_in: 900, access: [{ type: 'repository', name: repo, actions: ['pull', 'push'] }] });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer resource:hospital-a/models/architecture');
    assert.equal(init?.credentials, 'omit'); return Response.json({ tags: ['issued'] });
  };
  await c.login(null); assert.equal(popup.requests[0].searchParams.get('scope'), 'ifcx:session');
  assert(c.can('push', 'hospital-a/models/architecture', 'review-2')); assert(!c.can('push', 'hospital-a/models/architecture', 'draft'));
  await Promise.all([c.request('/v2/hospital-a/models/architecture/tags/list'), c.request('/v2/hospital-a/models/architecture/manifests/issued')]);
  assert.equal(exchanges, 1); assert.equal(popup.opens(), 1);
});

test('fragment share links redeem over POST, renew without cookies, and sign out locally', async context => {
  const secret = 'a'.repeat(64); const c = client(); let now = Date.now(); context.mock.method(Date, 'now', () => now);
  const parsed = parseRegistryAddress(`${registry}/share#secret=${secret}`); assert.equal(parsed.shareSecret, secret);
  assert.throws(() => parseRegistryAddress(`http://evil.example/share#secret=${secret}`));
  assert.throws(() => parseRegistryAddress(`${registry}/share?secret=${secret}`));
  let redemptions = 0;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    assert(!url.href.includes(secret)); assert.equal(init?.credentials, 'omit');
    if (url.pathname === '/shares/redeem') {
      redemptions++; assert.equal(init?.method, 'POST'); assert.deepEqual(JSON.parse(String(init?.body)), { secret });
      const reply = rootReply(); const { refresh_token: _refresh, ...publicReply } = reply;
      return Response.json({ ...publicReply, subject: 'share:guest', authorization_type: 'share', session_expires_in: 86400, session_expires_at: Math.floor(now / 1000) + 86400 });
    }
    if (url.pathname === '/token') return Response.json({ access_token: 'guest-resource', expires_in: 900, access: [{ type: 'repository', name: 'hospital-a/model', actions: ['pull'] }] });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer guest-resource'); return Response.json({ tags: ['issued'] });
  };
  const before = localStorage.length; await c.loginShare(secret); const deadline = c.session!.sessionExpiresAt;
  await c.request('/v2/hospital-a/model/tags/list'); now += 901000; await c.request('/v2/hospital-a/model/tags/list');
  assert.equal(redemptions, 2); assert.equal(c.session?.sessionExpiresAt, deadline); assert.equal(localStorage.length, before);
  await assert.rejects(c.shareRequest('/shares'), /account/); await c.signOut(); assert.equal(c.session, null); assert.equal(await c.restore(), null);
});


test("concurrent exchanges for different identities never reuse each other's token cache", async () => {
  const tokens = new ScopedTokens(); const repo = 'hospital-a/model'; let complete!: (value: Response) => void;
  globalThis.fetch = async (_input, init) => {
    const bearer = new Headers(init?.headers).get('Authorization');
    if (bearer === 'Bearer first-root') return new Promise<Response>(resolve => { complete = resolve; });
    assert.equal(bearer, 'Bearer second-root');
    return Response.json({ access_token: 'second-resource', expires_in: 900, access: [{ type: 'repository', name: repo, actions: ['pull'] }] });
  };
  const first = tokens.token(window.location.origin, 'first-root', repo);
  assert.equal(await tokens.token(window.location.origin, 'second-root', repo), 'second-resource');
  complete(Response.json({ access_token: 'first-resource', expires_in: 900, access: [{ type: 'repository', name: repo, actions: ['pull'] }] }));
  assert.equal(await first, 'first-resource');
  assert.equal(await tokens.token(window.location.origin, 'second-root', repo), 'second-resource');
});
