/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { RegistryTransport } from './transport';
import type { RegistrySession } from './protocol';

const registry = 'http://127.0.0.1:5000';
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); globalThis.fetch = originalFetch; });

function transport(onSession?: (session: RegistrySession | null) => void) {
  const client = new RegistryTransport(window.location.origin, registry, onSession);
  cleanups.push(() => client.logout());
  return client;
}
function popup() { const browser = installRegistryPopup(registryCallback); cleanups.push(browser.restore); return browser; }
function remembered() {
  return registryTokenReply('writer', ['pull', 'push'], true);
}
function urlOf(input: Parameters<typeof fetch>[0]) { return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); }

test('parallel model requests renew one memory-only session without extending its 8-hour deadline (#8310)', async context => {
  let now = Date.now(); context.mock.method(Date, 'now', () => now);
  popup(); const client = transport(); let renewals = 0;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    if (url.pathname === '/oauth/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') return Response.json(registryTokenReply());
      renewals++; assert.equal(body.get('refresh_token'), 'test-refresh-only'); assert.equal(init?.credentials, 'omit');
      await new Promise(resolve => setImmediate(resolve));
      return Response.json({ ...registryTokenReply(), token: 'renewed', access_token: 'renewed', refresh_token: 'rotated' });
    }
    assert.equal(init?.credentials, 'omit'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer renewed');
    return Response.json({ tags: ['issued'] });
  };
  const session = await client.login(null); const deadline = session.sessionExpiresAt;
  now += 901000;
  assert(client.can('pull'), 'expired access tokens renew within the active session');
  await Promise.all([client.request('/v2/project/model/tags/list'), client.request('/v2/project/model/tags/list'), client.request('/v2/project/model/tags/list')]);
  assert.equal(renewals, 1); assert.equal(client.session?.sessionExpiresAt, deadline);
  now = deadline + 1;
  await assert.rejects(client.request('/v2/project/model/tags/list'), /expired/);
  assert.equal(renewals, 1);
});

test('a 401 gets one renewal and retry; ambiguous write failures are never retried (#8310)', async () => {
  popup(); const client = transport(); let dataCalls = 0; let renewals = 0; let failNetwork = false;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    if (url.pathname === '/oauth/token') {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') renewals++;
      return Response.json(registryTokenReply());
    }
    dataCalls++;
    if (failNetwork) throw new TypeError('Network response was lost');
    return new Response(null, { status: 401 });
  };
  await client.login(null);
  await assert.rejects(client.request('/v2/project/model/manifests/new', { method: 'PUT', body: '{}' }), /expired/);
  assert.equal(dataCalls, 2); assert.equal(renewals, 1);
  await client.login(null); failNetwork = true; dataCalls = 0;
  await assert.rejects(client.request('/v2/project/model/manifests/new', { method: 'PUT', body: '{}' }), /lost/);
  assert.equal(dataCalls, 1); assert.equal(renewals, 1);
});

test('remembered sessions restore without a popup and serialize rotations across tabs (#8310)', async context => {
  context.mock.method(window, 'open', () => { throw new Error('Restore must not open a popup'); });
  const first = transport(); const second = transport(); let active = 0; let maximum = 0; let rotations = 0;
  const rememberedReply = remembered();
  const before = Array.from({ length: localStorage.length }, (_, index) => { const key = localStorage.key(index)!; return [key, localStorage.getItem(key)]; });
  globalThis.fetch = async (input, init) => {
    if (urlOf(input).pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.has('refresh_token'), false);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.referrerPolicy, 'same-origin');
    rotations++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return Response.json(rememberedReply);
  };
  const sessions = await Promise.all([first.restore(), second.restore()]);
  assert(sessions.every(session => session?.remembered));
  assert.equal(maximum, 1); assert.equal(rotations, 2);
  assert.equal(first.session?.sessionExpiresAt, second.session?.sessionExpiresAt);
  assert.deepEqual(Array.from({ length: localStorage.length }, (_, index) => { const key = localStorage.key(index)!; return [key, localStorage.getItem(key)]; }), before);
});

test('remembered sign-out clears other tabs while independent memory sessions remain connected (#8310)', async () => {
  let otherCleared!: () => void;
  const notification = new Promise<void>(resolve => { otherCleared = resolve; });
  const first = transport(session => { if (!session) otherCleared(); });
  const second = transport(); const memory = transport(); popup();
  let cookieValid = true; let revoked = 0;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    const body = new URLSearchParams(String(init?.body));
    if (url.pathname === '/oauth/revoke') { assert.equal(init?.credentials, 'include'); assert.equal(body.has('token'), false); cookieValid = false; revoked++; return new Response(null, { status: 200 }); }
    if (body.get('grant_type') === 'authorization_code') return Response.json(registryTokenReply());
    return cookieValid ? Response.json(remembered()) : Response.json({ error: 'invalid_grant' }, { status: 401 });
  };
  await first.restore(); await second.restore(); await memory.login(null);
  await second.signOut(); await notification;
  assert.equal(first.session, null); assert.equal(second.session, null); assert(memory.can('pull'));
  assert.equal(revoked, 1); assert.equal(await transport().restore(), null);
});

test('sign-out revokes a consumed refresh token and a late renewal cannot restore access (#8310)', async context => {
  let now = Date.now(); context.mock.method(Date, 'now', () => now);
  popup(); const client = transport();
  let began!: () => void; const renewing = new Promise<void>(resolve => { began = resolve; });
  let release!: (response: Response) => void; let revoked = '';
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
    const body = new URLSearchParams(String(init?.body));
    if (url.pathname === '/oauth/revoke') { revoked = body.get('token') ?? ''; return new Response(null, { status: 200 }); }
    if (body.get('grant_type') === 'authorization_code') return Response.json(registryTokenReply());
    return new Promise<Response>(resolve => { release = resolve; began(); });
  };
  await client.login(null); now += 901000;
  const request = client.request('/v2/project/model/tags/list'); const rejected = assert.rejects(request, { name: 'AbortError' });
  await renewing; const signingOut = client.signOut();
  release(Response.json({ ...registryTokenReply(), refresh_token: 'already-rotated' }));
  await rejected; await signingOut;
  assert.equal(revoked, 'test-refresh-only'); assert.equal(client.session, null); assert.equal(client.can('pull'), false);
});

test('failed server sign-out clears access and remains retryable without silently restoring (#8310)', async () => {
  popup(); const client = transport(); let fail = true;
  globalThis.fetch = async input => urlOf(input).pathname === '/oauth/config' ? Response.json(registryOAuthConfig(registry))
    : urlOf(input).pathname === '/oauth/revoke' ? new Response(null, { status: fail ? 503 : 200 }) : Response.json(registryTokenReply());
  await client.login(null);
  await assert.rejects(client.signOut(), /retry/);
  assert.equal(client.can('pull'), false); assert.equal(await client.restore(), null);
  await assert.rejects(client.login(null), /finish signing out/);
  fail = false; await client.signOut();
  assert.equal(client.session, null);
});

test('sign-out during restore or code exchange revokes a late remembered cookie before reload (#8310)', async context => {
  for (const phase of ['restore', 'code'] as const) await context.test(phase, async () => {
    popup(); const client = transport(); let cookieValid = false;
    let began!: () => void; const exchanging = new Promise<void>(resolve => { began = resolve; });
    let release!: (response: Response) => void; let pending = true; let revoked = 0;
    globalThis.fetch = async (input, init) => {
      const url = urlOf(input);
      if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registry));
      if (url.pathname === '/oauth/revoke') { cookieValid = false; revoked++; assert.equal(init?.credentials, 'include'); return new Response(null, { status: 200 }); }
      if (pending) return new Promise<Response>(resolve => { release = resolve; began(); });
      return cookieValid ? Response.json(remembered()) : Response.json({ error: 'invalid_grant' }, { status: 401 });
    };
    const request = phase === 'restore' ? client.restore() : client.login(null);
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await exchanging;
    const signingOut = client.signOut();
    cookieValid = true; pending = false; release(Response.json(remembered()));
    await rejected; await signingOut;
    assert.equal(revoked, 1); assert.equal(cookieValid, false);
    assert.equal(await transport().restore(), null, 'a fresh tab cannot restore the revoked remembered cookie');
  });
});
