/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { deriveCodeChallengeS256 } from '@ifc-lite/oauth-pkce';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { RegistryTransport } from './transport';
import { REGISTRY_CALLBACK_PATH, validateRegistryCallback, validateRegistryOAuthConfig } from './oauth';

const registryOrigin = 'http://127.0.0.1:5000';
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); globalThis.fetch = originalFetch; });

function fixture(authorize: (request: URL) => string | Promise<string> = registryCallback) {
  const popup = installRegistryPopup(authorize);
  const transport = new RegistryTransport(window.location.origin);
  cleanups.push(popup.restore, () => transport.logout());
  const exchanges: URLSearchParams[] = [];
  globalThis.fetch = async (input, init) => {
    assert(popup.opens() > 0, 'popup opens before asynchronous network discovery');
    const url = new URL(String(input));
    assert.equal(url.origin, window.location.origin);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    if (url.pathname === '/oauth/config') return Response.json(registryOAuthConfig(registryOrigin));
    assert.equal(url.pathname, '/oauth/token', 'browser never uses Basic /token');
    assert.equal(init?.method, 'POST');
    const body = new URLSearchParams(String(init.body)); exchanges.push(body);
    assert.equal(body.has('password'), false); assert.equal(body.has('username'), false); assert.equal(body.has('client_secret'), false);
    return Response.json(registryTokenReply());
  };
  return { popup, transport, exchanges };
}

test('registry login sends an S256 challenge and redeems its matching verifier without credentials (#8310)', async () => {
  const { popup, transport, exchanges } = fixture();
  await transport.login(null);
  const request = popup.requests[0]; assert(request);
  assert.equal(request.origin, registryOrigin); assert.equal(request.pathname, '/oauth/authorize');
  assert.equal(request.searchParams.get('client_id'), 'ifc-lite');
  assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(request.searchParams.get('scope'), 'registry:catalog:read');
  assert.equal(request.searchParams.has('code_verifier'), false);
  const verifier = exchanges[0].get('code_verifier'); assert(verifier);
  assert.equal(await deriveCodeChallengeS256(verifier), request.searchParams.get('code_challenge'));
  assert.equal(exchanges[0].get('redirect_uri'), `${window.location.origin}${REGISTRY_CALLBACK_PATH}`);
  assert.equal(exchanges[0].get('grant_type'), 'authorization_code');
  assert(transport.can('push', 'project/model'));
  await transport.login('project/model');
  assert.equal(popup.requests[1].searchParams.get('scope'), 'repository:project/model:pull,push');
  assert.notEqual(popup.requests[1].searchParams.get('state'), request.searchParams.get('state'));
  assert.notEqual(exchanges[1].get('code_verifier'), verifier);
  assert.deepEqual(popup.errors, []);
});

test('registry OAuth discovery is limited to the configured registry and registered viewer callback (#8310)', () => {
  const redirect = `${window.location.origin}${REGISTRY_CALLBACK_PATH}`;
  const valid = registryOAuthConfig(registryOrigin);
  assert.deepEqual(validateRegistryOAuthConfig(valid, registryOrigin, redirect), { clientId: valid.client_id, authorizationEndpoint: valid.authorization_endpoint });
  assert.equal(validateRegistryOAuthConfig({ ...valid, client_id: 'another-viewer' }, registryOrigin, redirect).clientId, 'another-viewer');
  for (const changed of [
    { authorization_endpoint: 'https://foreign.example/oauth/authorize' },
    { authorization_endpoint: `${registryOrigin}/oauth/authorize?client_id=other` },
    { authorization_endpoint: `${registryOrigin}/api/other` },
    { token_endpoint: '/token' }, { token_endpoint: 'https://foreign.example/oauth/token' },
    { client_id: '' }, { client_id: 'unsafe client' }, { redirect_uris: [] }, { code_challenge_methods_supported: ['plain'] },
  ]) assert.throws(() => validateRegistryOAuthConfig({ ...valid, ...changed }, registryOrigin, redirect));
});

test('registry callback validation rejects origin/path/state confusion and ambiguous parameters (#8310)', () => {
  const redirect = `${window.location.origin}${REGISTRY_CALLBACK_PATH}`;
  const valid = `${redirect}?state=expected&code=issued`;
  assert.equal(validateRegistryCallback(valid, redirect, 'expected'), 'issued');
  for (const callback of [
    valid.replace('localhost', 'foreign.example'), valid.replace('/registry/', '/dropbox/'),
    valid.replace('expected', 'other'), `${valid}&state=expected`, `${valid}&code=other`, `${valid}#fragment`,
    `${valid}&error=access_denied`, `${redirect}?state=expected&error=access_denied&error=server_error`,
    `${redirect}?state=expected`, `${redirect}?code=issued`,
  ]) assert.throws(() => validateRegistryCallback(callback, redirect, 'expected'));
  assert.throws(() => validateRegistryCallback(`${redirect}?state=expected&error=access_denied`, redirect, 'expected'), /access_denied/);
});

test('a callback for another route cannot trigger a registry token exchange (#8310)', async () => {
  const { transport, exchanges } = fixture(request => registryCallback(request).replace('/registry/', '/dropbox/'));
  await assert.rejects(transport.login(null), /does not match/);
  assert.equal(exchanges.length, 0);
});

test('registry sign-out prevents an in-flight token response from restoring the session (#8310)', async () => {
  const { transport } = fixture();
  const baseFetch = globalThis.fetch;
  let complete!: (response: Response) => void;
  let started!: () => void;
  const exchanging = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== '/oauth/token') return baseFetch(input, init);
    return new Promise<Response>(resolve => { complete = resolve; started(); });
  };
  const pending = transport.login(null);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await exchanging; transport.logout(); complete(Response.json(registryTokenReply()));
  await rejected;
  await assert.rejects(transport.request('/v2/project/model/tags/list'), /expired/);
});

test('closing Cloud Sources during discovery aborts sign-in before popup navigation (#8310)', async () => {
  const { transport, popup } = fixture();
  let complete!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
  const controller = new AbortController();
  const pending = transport.login(null, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); complete(Response.json(registryOAuthConfig(registryOrigin)));
  await rejected; assert.equal(popup.requests.length, 0);
  assert.equal(transport.can('pull'), false);
});

test('blocked popups and malformed tokens never create a registry session (#8310)', async () => {
  const { transport } = fixture();
  const originalOpen = window.open;
  window.open = () => null;
  await assert.rejects(transport.login(null), /Allow.*popup/);
  window.open = originalOpen;
  const withPopup = window.open;
  window.open = (...args) => {
    const opened = withPopup(...args); assert(opened);
    Object.defineProperty(opened.location, 'href', { set() { throw new Error('Navigation refused'); } });
    return opened;
  };
  await assert.rejects(transport.login(null), /Navigation refused/);
  window.open = withPopup;
  const baseFetch = globalThis.fetch;
  for (const changed of [{ access_token: ' ' }, { expires_in: Infinity }, { expires_in: 901 }, { token_type: 'Basic' }, { subject: '' }, { access: [] }]) {
    globalThis.fetch = async (input, init) => new URL(String(input)).pathname === '/oauth/token'
      ? Response.json({ ...registryTokenReply(), ...changed }) : baseFetch(input, init);
    await assert.rejects(transport.login(null));
    assert.equal(transport.can('pull'), false);
  }
});

test('registry sign-in times out and releases its callback waiter (#8310)', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let navigated!: () => void;
  const opened = new Promise<void>(resolve => { navigated = resolve; });
  const { transport, popup, exchanges } = fixture(() => { navigated(); return new Promise<string>(() => {}); });
  const pending = transport.login(null);
  const rejected = assert.rejects(pending, /timed out/);
  await opened;
  assert.equal(popup.requests.length, 1);
  context.mock.timers.tick(5 * 60 * 1000);
  await rejected;
  assert.equal(exchanges.length, 0); assert.equal(transport.can('pull'), false);
});
