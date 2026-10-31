/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * buildagil relay. Its token route holds the client secret, so the guards
 * here are what stop a public endpoint becoming a credentialed proxy: one
 * fixed token URL, exact grant fields, this deployment's client id, the
 * redirect and origin allowlists, and the secret never coming back. Its API
 * route holds nothing, but is still an allowlist, not a pass-through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildagilRelayHandler, loadBuildagilRelayConfig, type BuildagilRelayConfig } from '../../server/sources/buildagil-relay.js';
import { relayedQuery, resolveBuildagilRoute } from '../../server/sources/buildagil-routes.js';

const ORIGIN = 'https://www.ifclite.com';
const SECRET = 'S3CRET-sentinel-value';
const CLIENT = 'client-123';
const REDIRECT = 'https://www.ifclite.com/oauth/bcf/callback';
const VERIFIER = 'v'.repeat(43);
const PROJECT = 'p-1';
const DOC = '0f8fad5b-d9cb-469f-a165-70867728950e';

interface Captured { url: string; method: string; headers: Headers; body: string }

function relay(respond: (call: Captured) => Response | Promise<Response> = () => Response.json([]), overrides: Partial<BuildagilRelayConfig> = {}) {
  const calls: Captured[] = [];
  const config = { ...loadBuildagilRelayConfig({ BUILDAGIL_CLIENT_ID: CLIENT, BUILDAGIL_CLIENT_SECRET: SECRET }), ...overrides };
  const handler = createBuildagilRelayHandler(config, {
    fetchImpl: async (input, init) => {
      const call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
      calls.push(call);
      assert.equal(init?.redirect, 'manual');
      return respond(call);
    },
  });
  return { handler, calls };
}

function get(path: string, headers: Record<string, string> = { authorization: 'Bearer tok', origin: ORIGIN }): Request {
  return new Request(`${ORIGIN}/api/buildagil/${path}`, { headers });
}

function tokenRequest(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/buildagil/oauth2/token`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const REFRESH = { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: CLIENT };
const CODE = { grant_type: 'authorization_code', code: 'c-1', redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER };

test('route allowlist: documents reads, search and the token route only', () => {
  for (const path of ['1.0/projects', `1.0/projects/${PROJECT}/documents`, `1.0/projects/${PROJECT}/documents/${DOC}`,
    `1.0/projects/${PROJECT}/documents/${DOC}/metadata`, `1.0/projects/${PROJECT}/documents/${DOC}/versions`,
    `1.0/projects/${PROJECT}/documents/${DOC}/versions/3`]) {
    assert.ok(resolveBuildagilRoute(path, 'GET'), path);
  }
  assert.equal(resolveBuildagilRoute('1.0/search', 'POST')?.kind, 'api');
  assert.equal(resolveBuildagilRoute('oauth2/token', 'POST')?.kind, 'token');
  for (const [path, method] of [
    ['1.0/search', 'GET'], ['oauth2/token', 'GET'], [`1.0/projects/${PROJECT}/documents`, 'POST'],
    [`1.0/projects/${PROJECT}/topics`, 'GET'], [`1.0/projects/${PROJECT}/documents/${DOC}`, 'PUT'],
    [`1.0/projects/../documents`, 'GET'], [`1.0/projects/${PROJECT}%2Fx/documents`, 'GET'],
    ['1.0//projects', 'GET'], ['oauth2/authorize', 'GET'], ['foundation/versions', 'GET'],
    [`1.0/projects/${PROJECT}/documents/${DOC}/versions/-1`, 'GET'],
  ]) {
    assert.equal(resolveBuildagilRoute(path, method), null, `${method} ${path}`);
  }
});

test('query: allowed keys once each, the rewrite path dropped, encoding kept', () => {
  const allowed = ['$filter', '$orderby', '$top'];
  assert.equal(relayedQuery("?path=x&%24filter=file_type%20eq%20'ifc'&$top=100", allowed), "%24filter=file_type%20eq%20'ifc'&$top=100");
  assert.equal(relayedQuery('?$top=1&$top=2', allowed), null);
  assert.equal(relayedQuery('?$skip=1', allowed), null);
  assert.equal(relayedQuery('?$top=1', []), null);
  assert.equal(relayedQuery('', allowed), '');
});

test('API reads forward the bearer and allowed query, nothing else either way', async () => {
  const { handler, calls } = relay(() => new Response('[]', {
    headers: { 'content-type': 'application/json', 'set-cookie': 'upstream=1', 'x-internal': 'y' },
  }));
  const response = await handler(new Request(
    `${ORIGIN}/api/buildagil/1.0/projects/${PROJECT}/documents?%24filter=file_type%20eq%20'ifc'&%24top=100`,
    { headers: { authorization: 'Bearer tok', origin: ORIGIN, cookie: 'session=1' } },
  ));
  assert.equal(response.status, 200);
  // The URL parser escapes the quotes; the upstream decodes the same filter.
  assert.equal(calls[0].url, `https://openapi.buildagil.com/1.0/projects/${PROJECT}/documents?%24filter=file_type%20eq%20%27ifc%27&%24top=100`);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok');
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-internal'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
});

test('Vercel rewrite form (?path=) resolves the same route', async () => {
  const { handler, calls } = relay();
  const response = await handler(new Request(`${ORIGIN}/api/buildagil?path=1.0%2Fprojects`, { headers: { authorization: 'Bearer tok' } }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://openapi.buildagil.com/1.0/projects');
});

test('API refusals never reach upstream', async () => {
  const { handler, calls } = relay();
  assert.equal((await handler(get('1.0/projects', { origin: ORIGIN }))).status, 401);
  assert.equal((await handler(get('1.0/projects', { authorization: 'Bearer tok', origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handler(get(`1.0/projects/${PROJECT}/topics`))).status, 400);
  assert.equal((await handler(get('1.0/projects?$top=5'))).status, 400);
  assert.equal(calls.length, 0);
});

test('download: a storage redirect is followed without the bearer; other hosts are refused', async () => {
  const blob = 'https://acct.blob.core.windows.net/c/model.ifc?sig=abc';
  const { handler, calls } = relay((call) => call.url.startsWith('https://openapi.buildagil.com/')
    ? new Response(null, { status: 302, headers: { location: blob } })
    : new Response('ISO-10303-21;', { headers: { 'content-type': 'application/octet-stream' } }));
  const response = await handler(get(`1.0/projects/${PROJECT}/documents/${DOC}`));
  assert.equal(await response.text(), 'ISO-10303-21;');
  assert.equal(calls[1].url, blob);
  assert.equal(calls[1].headers.get('authorization'), null);

  const offHost = relay(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } }));
  assert.equal((await offHost.handler(get(`1.0/projects/${PROJECT}/documents/${DOC}`))).status, 502);
  assert.equal(offHost.calls.length, 1);

  // A listing never hops to storage, even when asked to.
  const listing = relay(() => new Response(null, { status: 302, headers: { location: blob } }));
  assert.equal((await listing.handler(get('1.0/projects'))).status, 502);

  const login = relay(() => new Response(null, { status: 302, headers: { location: 'https://login.microsoftonline.com/t/oauth2/v2.0/authorize' } }));
  assert.equal((await login.handler(get('1.0/projects'))).status, 401);
});

test('search: POST with JSON from an allowed origin is forwarded with its body', async () => {
  const { handler, calls } = relay(() => Response.json({ items: [] }));
  const body = JSON.stringify({ targets: ['Document'], search_text: 'arch', project_ids: [PROJECT] });
  const request = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/buildagil/1.0/search`, {
    method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json', ...headers }, body,
  });
  assert.equal((await handler(request({ origin: ORIGIN }))).status, 200);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, body);
  assert.equal((await handler(request({}))).status, 403);
  assert.equal((await handler(request({ origin: ORIGIN, 'content-type': 'text/plain' }))).status, 415);
  assert.equal(calls.length, 1);
});

test('rate limiting: 429 keeps Retry-After so the host can back off', async () => {
  const { handler } = relay(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
  const response = await handler(get('1.0/projects'));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '7');
});

test('token: a refresh grant gets the secret, goes to the fixed URL, and only token fields come back', async () => {
  const { handler, calls } = relay(() => Response.json({
    access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', client_secret: SECRET, extra: 1,
  }));
  const response = await handler(tokenRequest(REFRESH));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://openapi.buildagil.com/oauth2/token');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('client_secret'), SECRET);
  assert.equal(form.get('client_id'), CLIENT);
  assert.equal(form.get('refresh_token'), 'rt-1');
  const text = await response.text();
  assert.ok(!text.includes(SECRET));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['access_token', 'expires_in', 'refresh_token', 'token_type']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('token: a code exchange carries the verifier and a registered redirect', async () => {
  const { handler, calls } = relay(() => Response.json({ access_token: 'at' }));
  assert.equal((await handler(tokenRequest(CODE))).status, 200);
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('code_verifier'), VERIFIER);
  assert.equal(form.get('redirect_uri'), REDIRECT);
});

test('token refusals never reach upstream', async () => {
  const { handler, calls } = relay();
  const cases: [Request, number][] = [
    [tokenRequest({ ...REFRESH, client_id: 'other' }), 400],
    [tokenRequest({ ...REFRESH, scope: 'everything' }), 400],
    [tokenRequest({ ...CODE, redirect_uri: 'https://evil.test/cb' }), 400],
    [tokenRequest({ ...CODE, code_verifier: 'short' }), 400],
    [tokenRequest({ ...REFRESH, grant_type: 'client_credentials' }), 400],
    [tokenRequest(REFRESH, { origin: 'https://evil.test' }), 403],
    [tokenRequest(REFRESH, { 'sec-fetch-site': 'cross-site' }), 403],
    [tokenRequest(REFRESH, { 'content-type': 'application/json' }), 415],
  ];
  for (const [request, status] of cases) assert.equal((await handler(request)).status, status);
  const noOrigin = new Request(`${ORIGIN}/api/buildagil/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(REFRESH).toString(),
  });
  assert.equal((await handler(noOrigin)).status, 403);
  assert.equal(calls.length, 0);
});

test('token: an unconfigured deployment answers relay_not_configured', async () => {
  const { handler, calls } = relay(undefined, { clientId: '', clientSecret: '' });
  const response = await handler(tokenRequest(REFRESH));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'relay_not_configured');
  assert.equal(calls.length, 0);
});

test('token: upstream errors pass through with the secret scrubbed; redirects are refused', async () => {
  const failing = relay(() => Response.json({ error: 'invalid_grant', error_description: `bad ${SECRET}` }, { status: 400 }));
  const response = await failing.handler(tokenRequest(REFRESH));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'invalid_grant');
  assert.ok(!body.error_description.includes(SECRET));

  const redirecting = relay(() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
  assert.equal((await redirecting.handler(tokenRequest(REFRESH))).status, 502);
  assert.equal(redirecting.calls.length, 1);
});

test('config: defaults to the registered callbacks and their origins plus APP_URL', () => {
  const config = loadBuildagilRelayConfig({ APP_URL: 'https://preview.example' });
  assert.deepEqual(config.allowedRedirectUris, ['https://www.ifclite.com/oauth/bcf/callback', 'http://localhost:5000/oauth/bcf/callback']);
  assert.deepEqual(config.allowedOrigins, ['https://preview.example', 'https://www.ifclite.com', 'http://localhost:5000']);
  assert.equal(config.clientSecret, '');
  assert.deepEqual(loadBuildagilRelayConfig({ BUILDAGIL_RELAY_ALLOWED_ORIGINS: 'https://a.test, https://b.test' }).allowedOrigins,
    ['https://a.test', 'https://b.test']);
});
