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
const BCF_PROJECT = '185732';
const TOPIC = '0002d584-0100-0030-0000-000000000000';
const VIEWPOINT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOPICS_PATH = `1.0/projects/${BCF_PROJECT}/topics`;
const TOPIC_PATH = `${TOPICS_PATH}/${TOPIC}`;
const VIEWPOINT_PATH = `${TOPIC_PATH}/viewpoints/${VIEWPOINT}`;

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
    [`1.0/projects/${PROJECT}/members`, 'GET'], [`1.0/projects/${PROJECT}/documents/${DOC}`, 'PUT'],
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
  assert.equal((await handler(get(`1.0/projects/${PROJECT}/members`))).status, 400);
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

test('BCF route table: each topic route with its method and query keys; anything else refused', () => {
  const reads: [string, string[]][] = [
    [`1.0/projects/${BCF_PROJECT}`, []], [`1.0/projects/${BCF_PROJECT}/extensions`, []],
    [TOPICS_PATH, ['$filter', '$orderby', '$top', '$expand']], [TOPIC_PATH, ['$expand']],
    [`${TOPIC_PATH}/comments`, []], [`${TOPIC_PATH}/viewpoints`, []], [VIEWPOINT_PATH, []],
    [`${VIEWPOINT_PATH}/selection`, []], [`${VIEWPOINT_PATH}/coloring`, []],
    [`${VIEWPOINT_PATH}/visibility`, []], [`${VIEWPOINT_PATH}/snapshot`, []],
  ];
  for (const [path, keys] of reads) {
    for (const method of ['GET', 'HEAD']) {
      const route = resolveBuildagilRoute(path, method);
      assert.ok(route?.kind === 'api' && route.method === 'GET', `${method} ${path}`);
      assert.deepEqual(route.queryKeys, keys, path);
      assert.equal(route.download, false, path);
      assert.equal(route.target.toString(), `https://openapi.buildagil.com/${path}`);
    }
  }
  const writes: [string, string, number][] = [
    [TOPICS_PATH, 'POST', 64 * 1024], [TOPIC_PATH, 'PUT', 64 * 1024],
    [`${TOPIC_PATH}/comments`, 'POST', 64 * 1024], [`${TOPIC_PATH}/viewpoints`, 'POST', 16 * 1024 * 1024],
    ['1.0/search', 'POST', 64 * 1024],
  ];
  for (const [path, method, cap] of writes) {
    const route = resolveBuildagilRoute(path, method);
    assert.ok(route?.kind === 'api' && route.method === method, `${method} ${path}`);
    assert.ok(route.method !== 'GET' && route.maxBodyBytes === cap && route.queryKeys.length === 0, path);
  }
  for (const [path, method] of [
    [TOPICS_PATH, 'PUT'], [TOPIC_PATH, 'POST'], [TOPIC_PATH, 'PATCH'], [TOPIC_PATH, 'DELETE'],
    [`${TOPIC_PATH}/comments/${VIEWPOINT}`, 'GET'], [`${TOPIC_PATH}/comments`, 'PUT'],
    [VIEWPOINT_PATH, 'PUT'], [VIEWPOINT_PATH, 'POST'], [`${VIEWPOINT_PATH}/bitmaps`, 'GET'],
    [`${VIEWPOINT_PATH}/snapshot`, 'POST'], [`${VIEWPOINT_PATH}/selection/x`, 'GET'],
    [`1.0/projects/${BCF_PROJECT}/extensions`, 'PUT'], [`1.0/projects/${BCF_PROJECT}`, 'POST'],
    [`${TOPICS_PATH}/../documents`, 'GET'], [`${TOPICS_PATH}/a%2Fb`, 'GET'], ['1.0/search', 'PUT'],
  ]) {
    assert.equal(resolveBuildagilRoute(path, method), null, `${method} ${path}`);
  }
});

test('BCF queries: topics take filter/orderby/top/expand, a topic only expand', async () => {
  const { handler, calls } = relay();
  const filter = '%24filter=modified_date%20ge%202026-01-01T00%3A00%3A00.000Z&%24orderby=modified_date%20desc&%24top=50&%24expand=comments';
  assert.equal((await handler(get(`${TOPICS_PATH}?${filter}`))).status, 200);
  assert.equal(calls[0].url, `https://openapi.buildagil.com/${TOPICS_PATH}?${filter}`);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok');
  assert.equal((await handler(get(`${TOPIC_PATH}?$expand=comments`))).status, 200);
  for (const path of [`${TOPICS_PATH}?$skip=10`, `${TOPIC_PATH}?$filter=x`, `${TOPIC_PATH}/comments?$top=1`, `${VIEWPOINT_PATH}/snapshot?x=1`]) {
    assert.equal((await handler(get(path))).status, 400, path);
  }
  assert.equal(calls.length, 2);
});

function write(path: string, method: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/buildagil/${path}`, {
    method, body, headers: { authorization: 'Bearer tok', origin: ORIGIN, 'content-type': 'application/json', ...headers },
  });
}

test('BCF writes: a topic PUT and a viewpoint POST are forwarded with method and body intact', async () => {
  const { handler, calls } = relay(() => Response.json({ guid: TOPIC }, { status: 201 }));
  const topic = JSON.stringify({ title: 'Clash at grid C4', topic_status: 'Open', labels: ['MEP'] });
  const put = await handler(write(TOPIC_PATH, 'PUT', topic));
  assert.equal(put.status, 201);
  assert.match(put.headers.get('access-control-allow-methods') ?? '', /\bPUT\b/);
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].body], [`https://openapi.buildagil.com/${TOPIC_PATH}`, 'PUT', topic]);
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok');
  const viewpoint = JSON.stringify({ snapshot: { snapshot_type: 'png', snapshot_data: 'iVBORw0KGgo'.repeat(100) } });
  assert.equal((await handler(write(`${TOPIC_PATH}/viewpoints`, 'POST', viewpoint))).status, 201);
  assert.deepEqual([calls[1].url, calls[1].method, calls[1].body], [`https://openapi.buildagil.com/${TOPIC_PATH}/viewpoints`, 'POST', viewpoint]);

  const preflight = await handler(new Request(`${ORIGIN}/api/buildagil/${TOPIC_PATH}`, { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /\bPUT\b/);
});

test('BCF writes without Origin, with non-JSON, or redirected never land', async () => {
  const { handler, calls } = relay();
  const body = '{"comment":"x"}';
  for (const [path, method] of [[TOPICS_PATH, 'POST'], [TOPIC_PATH, 'PUT'], [`${TOPIC_PATH}/comments`, 'POST'], [`${TOPIC_PATH}/viewpoints`, 'POST']]) {
    const noOrigin = new Request(`${ORIGIN}/api/buildagil/${path}`, {
      method, body, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    });
    assert.equal((await handler(noOrigin)).status, 403, `${method} ${path} without Origin`);
    assert.equal((await handler(write(path, method, body, { 'content-type': 'text/plain' }))).status, 415, `${method} ${path} text/plain`);
    assert.equal((await handler(write(path, method, body, { origin: 'https://evil.test' }))).status, 403, `${method} ${path} foreign Origin`);
    assert.equal((await handler(write(path, method, body, { authorization: '' }))).status, 401, `${method} ${path} no bearer`);
  }
  assert.equal(calls.length, 0);

  const redirecting = relay(() => new Response(null, { status: 307, headers: { location: `https://openapi.buildagil.com/${TOPIC_PATH}` } }));
  assert.equal((await redirecting.handler(write(TOPIC_PATH, 'PUT', body))).status, 502);
  assert.equal(redirecting.calls.length, 1);
});

test('BCF body caps: a viewpoint admits ~1 MiB and refuses >16 MiB; a comment refuses >64 KiB', async () => {
  const { handler, calls } = relay(() => Response.json({}, { status: 201 }));
  const json = (bytes: number) => JSON.stringify({ snapshot: { snapshot_type: 'png', snapshot_data: 'A'.repeat(bytes) } });
  const viewpoints = `${TOPIC_PATH}/viewpoints`;
  assert.equal((await handler(write(viewpoints, 'POST', json(1024 * 1024)))).status, 201);
  assert.equal(calls[0].body.length, json(1024 * 1024).length);
  assert.equal((await handler(write(viewpoints, 'POST', json(16 * 1024 * 1024 + 1)))).status, 413);
  // A declared length over the cap is refused before the body is read.
  assert.equal((await handler(write(viewpoints, 'POST', '{}', { 'content-length': String(17 * 1024 * 1024) }))).status, 413);
  const comment = JSON.stringify({ comment: 'x'.repeat(64 * 1024) });
  assert.equal((await handler(write(`${TOPIC_PATH}/comments`, 'POST', comment))).status, 413);
  assert.equal((await handler(write(TOPIC_PATH, 'PUT', comment))).status, 413);
  assert.equal((await handler(write(`${TOPIC_PATH}/comments`, 'POST', '{"comment":"ok"}'))).status, 201);
  assert.equal(calls.length, 2);
});

test('BCF snapshot: binary streams through with its content-type; a storage redirect is refused', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);
  const { handler, calls } = relay(() => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) } }));
  const response = await handler(get(`${VIEWPOINT_PATH}/snapshot`, { authorization: 'Bearer tok', origin: ORIGIN, accept: 'image/*' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(png.byteLength));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(calls[0].headers.get('accept'), 'image/*');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok');

  const head = await handler(new Request(`${ORIGIN}/api/buildagil/${VIEWPOINT_PATH}/snapshot`, { method: 'HEAD', headers: { authorization: 'Bearer tok' } }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(calls[1].method, 'HEAD');

  const blob = relay(() => new Response(null, { status: 302, headers: { location: 'https://acct.blob.core.windows.net/c/s.png?sig=1' } }));
  assert.equal((await blob.handler(get(`${VIEWPOINT_PATH}/snapshot`))).status, 502);
  assert.equal(blob.calls.length, 1);
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

test('token: a public client (id, no secret) is forwarded without a secret or an Origin', async () => {
  const { handler, calls } = relay(() => Response.json({ access_token: 'at', refresh_token: 'rt-2' }), { clientSecret: '' });
  assert.equal((await handler(tokenRequest(CODE))).status, 200);
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.has('client_secret'), false);
  assert.equal(form.get('client_id'), CLIENT);
  assert.equal(form.get('code_verifier'), VERIFIER);
  // buildagil's gateway answers an origin it has not allowlisted with an
  // empty 200, so the relay never presents the browser's.
  assert.equal(calls[0].headers.get('origin'), null);
  // Still this deployment's client and a registered redirect only.
  assert.equal((await handler(tokenRequest({ ...CODE, client_id: 'other' }))).status, 400);
  assert.equal((await handler(tokenRequest({ ...CODE, redirect_uri: 'https://evil.test/cb' }))).status, 400);
  assert.equal(calls.length, 1);
});

test('token: a confidential client authenticates with its secret', async () => {
  const { handler, calls } = relay(() => Response.json({ access_token: 'at' }));
  assert.equal((await handler(tokenRequest(REFRESH))).status, 200);
  assert.equal(calls[0].headers.get('origin'), null);
});

test('token: an unconfigured deployment answers relay_not_configured', async () => {
  const { handler, calls } = relay(undefined, { clientId: '', clientSecret: SECRET });
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
