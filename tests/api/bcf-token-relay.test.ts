/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF OAuth token relay for confidential vendor clients (#4919). The relay
 * holds the BIMcollab client secret, so every guard here is what stops a
 * public endpoint becoming a credentialed proxy: the token URL host shape,
 * the exact grant fields, the redirect and origin allowlists, no redirects
 * followed, and the secret never appearing in anything sent back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIMCOLLAB_REGISTERED_REDIRECT_URIS,
  RELAY_NOT_CONFIGURED,
  createBcfTokenRelayHandler,
  loadBcfTokenRelayConfig,
  type BcfTokenRelayConfig,
} from '../../server/bcf/oauth-token-relay.js';
import { bimcollabTokenEndpoint } from '../../server/bcf/bimcollab-token-grant.js';

const APP_ORIGIN = 'https://www.ifclite.com';
const REDIRECT = 'https://www.ifclite.com/oauth/bcf/callback';
const TOKEN_URL = 'https://myspace.bimcollab.com/identity/connect/token';
const SECRET = 'S3CRET-sentinel-value';
const VERIFIER = 'v'.repeat(43);

function createConfig(overrides: Partial<BcfTokenRelayConfig> = {}): BcfTokenRelayConfig {
  return {
    ...loadBcfTokenRelayConfig({
      BCF_BIMCOLLAB_CLIENT_ID: '4e5649c2-6ea1-4736-8abc-8a91bbefcde3',
      BCF_BIMCOLLAB_CLIENT_SECRET: SECRET,
    }),
    ...overrides,
  };
}

interface Captured {
  url: string;
  form: URLSearchParams;
  redirect: RequestRedirect | undefined;
  hasSignal: boolean;
}

function createRelay(
  overrides: Partial<BcfTokenRelayConfig> = {},
  respond: (init: RequestInit | undefined) => Response | Promise<Response> = () =>
    Response.json({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt-1',
      client_secret: SECRET,
    }),
) {
  const captured: Captured[] = [];
  const handler = createBcfTokenRelayHandler(createConfig(overrides), {
    fetchImpl: async (input, init) => {
      captured.push({
        url: String(input),
        form: new URLSearchParams(String(init?.body)),
        redirect: init?.redirect,
        hasSignal: init?.signal instanceof AbortSignal,
      });
      return respond(init);
    },
  });
  return { handler, captured };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}/api/bcf/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const codeGrant = (overrides: Record<string, unknown> = {}) => ({
  grantType: 'authorization_code',
  tokenUrl: TOKEN_URL,
  code: 'code-1',
  redirectUri: REDIRECT,
  codeVerifier: VERIFIER,
  ...overrides,
});

const refreshGrant = (overrides: Record<string, unknown> = {}) => ({
  grantType: 'refresh_token',
  tokenUrl: TOKEN_URL,
  refreshToken: 'rt-0',
  ...overrides,
});

test('code exchange injects the server-held client credentials and returns the token set', async () => {
  const { handler, captured } = createRelay();
  const response = await handler(post(codeGrant()));

  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, TOKEN_URL);
  const form = captured[0].form;
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-1');
  assert.equal(form.get('redirect_uri'), REDIRECT);
  assert.equal(form.get('code_verifier'), VERIFIER);
  assert.equal(form.get('client_id'), '4e5649c2-6ea1-4736-8abc-8a91bbefcde3');
  assert.equal(form.get('client_secret'), SECRET);
  const token = (await response.json()) as Record<string, unknown>;
  assert.equal(token.access_token, 'at-1');
  assert.equal(token.refresh_token, 'rt-1');
  assert.equal(token.expires_in, 3600);
});

test('refresh grant injects the same credentials', async () => {
  const { handler, captured } = createRelay();
  const response = await handler(post(refreshGrant()));

  assert.equal(response.status, 200);
  const form = captured[0].form;
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'rt-0');
  assert.equal(form.get('client_secret'), SECRET);
  assert.equal(form.get('code'), null);
});

test('never follows a redirect and always bounds the upstream request with a signal', async () => {
  const { handler, captured } = createRelay();
  await handler(post(refreshGrant()));
  assert.equal(captured[0].redirect, 'manual');
  assert.equal(captured[0].hasSignal, true);
});

test('the secret appears in no response: success, upstream error, or upstream redirect', async () => {
  const success = await createRelay().handler(post(codeGrant()));
  assert.doesNotMatch(await success.text(), new RegExp(SECRET), 'token fields are allowlisted');

  const echoed = await createRelay({}, () =>
    Response.json(
      {
        error: 'invalid_client',
        error_description: `client_secret ${SECRET} is wrong`,
        client_secret: SECRET,
        trace: 'internal detail',
      },
      { status: 400 },
    ),
  ).handler(post(codeGrant()));
  assert.equal(echoed.status, 400, 'a vendor 4xx passes through so the viewer sees the OAuth error');
  const body = (await echoed.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'error_description']);
  assert.equal(body.error, 'invalid_client');
  assert.doesNotMatch(String(body.error_description), new RegExp(SECRET));

  const redirected = await createRelay({}, () =>
    new Response(null, { status: 307, headers: { location: `https://evil.example/?s=${SECRET}` } }),
  ).handler(post(codeGrant()));
  assert.equal(redirected.status, 502);
  assert.doesNotMatch(await redirected.text(), new RegExp(SECRET));
});

test('a vendor 5xx is reported as a bad gateway with only the OAuth fields', async () => {
  const response = await createRelay({}, () =>
    new Response('<html>stack trace with secrets</html>', { status: 500 }),
  ).handler(post(refreshGrant()));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream_error' });
});

test('every response is uncacheable', async () => {
  const ok = await createRelay().handler(post(codeGrant()));
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const rejected = await createRelay().handler(post(codeGrant({ tokenUrl: 'https://evil.example/token' })));
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
});

test('tokenUrl must be exactly a BIMcollab space token endpoint (no open proxy, no SSRF)', async () => {
  const rejected = [
    'http://myspace.bimcollab.com/identity/connect/token',
    'https://bimcollab.com/identity/connect/token',
    'https://a.b.bimcollab.com/identity/connect/token',
    'https://myspace.bimcollab.com.evil.example/identity/connect/token',
    'https://evilbimcollab.com/identity/connect/token',
    'https://myspace.bimcollab.com./identity/connect/token',
    'https://user:pw@myspace.bimcollab.com/identity/connect/token',
    'https://evil.example\\@myspace.bimcollab.com/identity/connect/token',
    'https://myspace.bimcollab.com:8443/identity/connect/token',
    'https://myspace.bimcollab.com/identity/connect/token/',
    'https://myspace.bimcollab.com/identity/connect/token?x=1',
    'https://myspace.bimcollab.com/identity/connect/authorize',
    'https://myspace.bimcollab.com/bcf/2.1/auth',
    'https://127.0.0.1/identity/connect/token',
    'https://-bad.bimcollab.com/identity/connect/token',
    '//myspace.bimcollab.com/identity/connect/token',
    '',
  ];
  for (const tokenUrl of rejected) {
    assert.equal(bimcollabTokenEndpoint(tokenUrl), null, tokenUrl);
    const { handler, captured } = createRelay();
    const response = await handler(post(codeGrant({ tokenUrl })));
    assert.equal(response.status, 400, tokenUrl);
    assert.equal(captured.length, 0, `${tokenUrl} must not reach the network`);
  }
  assert.equal(bimcollabTokenEndpoint('https://MySpace.BIMcollab.com/identity/connect/token'), TOKEN_URL);
  assert.equal(bimcollabTokenEndpoint(123), null);
});

test('redirectUri must be on the server allowlist, which defaults to the registered callbacks', async () => {
  assert.deepEqual(loadBcfTokenRelayConfig({}).allowedRedirectUris, BIMCOLLAB_REGISTERED_REDIRECT_URIS);
  assert.deepEqual(BIMCOLLAB_REGISTERED_REDIRECT_URIS, [
    'https://www.ifclite.com/oauth/bcf/callback',
    'http://localhost:5000/oauth/bcf/callback',
  ]);
  for (const redirectUri of [
    'https://evil.example/oauth/bcf/callback',
    'https://www.ifclite.com/oauth/bcf/callback/',
    'https://www.ifclite.com/oauth/bcf/callback?x=1',
  ]) {
    const { handler, captured } = createRelay();
    const response = await handler(post(codeGrant({ redirectUri })));
    assert.equal(response.status, 400, redirectUri);
    assert.equal(captured.length, 0);
  }
});

test('the authorization code exchange requires a PKCE verifier', async () => {
  for (const codeVerifier of ['', 'short', 'x'.repeat(129), `${'v'.repeat(42)} `]) {
    const { handler, captured } = createRelay();
    const response = await handler(post(codeGrant({ codeVerifier })));
    assert.equal(response.status, 400, JSON.stringify(codeVerifier));
    assert.equal(captured.length, 0);
  }
});

test('only the two grants, each with exactly its own fields, are relayed', async () => {
  const bodies: unknown[] = [
    { ...codeGrant(), grantType: 'client_credentials' },
    { ...codeGrant(), grantType: 'password', username: 'u', password: 'p' },
    { ...codeGrant(), scope: 'admin' },
    { ...codeGrant(), clientSecret: 'mine' },
    { ...refreshGrant(), clientId: 'other-client' },
    { ...refreshGrant(), code: 'code-1' },
    { grantType: 'refresh_token', tokenUrl: TOKEN_URL },
    { ...refreshGrant(), refreshToken: 'has space' },
    [codeGrant()],
    'null',
    'not json',
  ];
  for (const body of bodies) {
    const { handler, captured } = createRelay();
    const response = await handler(post(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(captured.length, 0, `${JSON.stringify(body)} must not reach the network`);
  }
});

test('requires an allowlisted Origin, a same-origin fetch, JSON, and POST', async () => {
  const cases: Array<[Request, number]> = [
    [post(codeGrant(), { origin: 'https://evil.example' }), 403],
    [post(codeGrant(), { 'sec-fetch-site': 'cross-site' }), 403],
    [post(codeGrant(), { 'content-type': 'application/x-www-form-urlencoded' }), 415],
    [post(codeGrant(), { 'content-type': 'text/plain' }), 415],
    [new Request(`${APP_ORIGIN}/api/bcf/oauth/token`, { method: 'GET', headers: { origin: APP_ORIGIN } }), 405],
  ];
  const missingOrigin = new Request(`${APP_ORIGIN}/api/bcf/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(codeGrant()),
  });
  cases.push([missingOrigin, 403]);
  for (const [request, status] of cases) {
    const { handler, captured } = createRelay();
    const response = await handler(request);
    assert.equal(response.status, status, `${request.method} ${request.headers.get('origin')}`);
    assert.equal(captured.length, 0);
  }

  const sameOrigin = await createRelay().handler(
    post(codeGrant(), { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }),
  );
  assert.equal(sameOrigin.status, 200);
});

test('origins default to the redirect allowlist origins, and both lists are env-overridable', () => {
  assert.deepEqual(loadBcfTokenRelayConfig({}).allowedOrigins, [
    'https://www.ifclite.com',
    'http://localhost:5000',
  ]);
  const custom = loadBcfTokenRelayConfig({
    BCF_BIMCOLLAB_REDIRECT_URIS: ' https://viewer.example/oauth/bcf/callback ,',
    BCF_TOKEN_RELAY_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
  });
  assert.deepEqual(custom.allowedRedirectUris, ['https://viewer.example/oauth/bcf/callback']);
  assert.deepEqual(custom.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(
    loadBcfTokenRelayConfig({ BCF_BIMCOLLAB_REDIRECT_URIS: 'https://viewer.example/cb' }).allowedOrigins,
    ['https://viewer.example'],
  );
});

test('caps the request body', async () => {
  const { handler, captured } = createRelay({ maxBodyBytes: 256 });
  const response = await handler(post(codeGrant({ code: 'c'.repeat(1024) })));
  assert.equal(response.status, 413);
  assert.equal(captured.length, 0);
});

test('an upstream that hangs is aborted at the timeout', async () => {
  const { handler } = createRelay({ upstreamTimeoutMs: 20 }, (init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  );
  const response = await handler(post(refreshGrant()));
  assert.equal(response.status, 504);
  assert.equal(((await response.json()) as Record<string, unknown>).error, 'upstream_timeout');
});

test('an unreachable upstream is a 502 that names nothing of the request', async () => {
  const { handler } = createRelay({}, () => {
    throw new TypeError(`fetch failed for client_secret=${SECRET}`);
  });
  const response = await handler(post(refreshGrant()));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), new RegExp(SECRET));
});

test('without client credentials in env the relay answers 503 relay_not_configured and makes no request', async () => {
  for (const env of [
    {},
    { BCF_BIMCOLLAB_CLIENT_ID: 'id-only' },
    { BCF_BIMCOLLAB_CLIENT_SECRET: 'secret-only' },
  ]) {
    const captured: string[] = [];
    const handler = createBcfTokenRelayHandler(loadBcfTokenRelayConfig(env), {
      fetchImpl: async (input) => {
        captured.push(String(input));
        return Response.json({});
      },
    });
    const response = await handler(post(codeGrant()));
    assert.equal(response.status, 503, JSON.stringify(env));
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, RELAY_NOT_CONFIGURED);
    assert.equal(captured.length, 0);
  }
});
