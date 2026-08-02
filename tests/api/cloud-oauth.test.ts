/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type OAuthProviderSpec,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  loadOAuthConfig,
  parseCookies,
  redirectUriFor,
  refreshAccessToken,
  refreshCookieName,
  serializeCookie,
  stateCookieName,
  OAuthTokenError,
} from '../../server/cloud-oauth/oauth-core.js';
import { createOAuthHandlers } from '../../server/cloud-oauth/oauth-handlers.js';
import { DROPBOX_SPEC, loadDropboxConfig } from '../../server/dropbox/dropbox.js';
import { ONEDRIVE_SPEC, loadOneDriveConfig } from '../../server/onedrive/onedrive.js';

const CONFIG = { clientId: 'client-id', clientSecret: 'client-secret' };

/** A fetch stub that returns a queued response and records the call. */
function stubFetch(responses: Response[]): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[i++];
    if (!res) throw new Error('stubFetch: no more responses queued');
    return res;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Provider-spec details ────────────────────────────────────────────────────

test('Dropbox spec requests an offline refresh token', () => {
  const url = new URL(buildAuthorizeUrl(DROPBOX_SPEC, { clientId: 'k', redirectUri: 'https://app/cb', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(url.searchParams.get('token_access_type'), 'offline');
  assert.match(url.searchParams.get('scope') ?? '', /files\.content\.read/);
});

test('Microsoft spec requests offline_access for a refresh token', () => {
  const url = new URL(buildAuthorizeUrl(ONEDRIVE_SPEC, { clientId: 'k', redirectUri: 'https://app/cb', state: 'st' }));
  assert.match(url.origin + url.pathname, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/);
  assert.match(url.searchParams.get('scope') ?? '', /offline_access/);
  assert.match(url.searchParams.get('scope') ?? '', /Files\.Read\.All/);
  assert.match(url.searchParams.get('scope') ?? '', /Sites\.Read\.All/);
});

test('config loaders read provider-specific env vars and tolerate absence', () => {
  assert.equal(loadDropboxConfig({}), null);
  assert.deepEqual(loadDropboxConfig({ DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' }), { clientId: 'k', clientSecret: 's' });
  assert.equal(loadOneDriveConfig({ MICROSOFT_CLIENT_ID: 'k' }), null);
  assert.deepEqual(loadOneDriveConfig({ MICROSOFT_CLIENT_ID: 'k', MICROSOFT_CLIENT_SECRET: 's' }), { clientId: 'k', clientSecret: 's' });
});

test('cookie names and redirect URIs are namespaced per provider', () => {
  assert.equal(stateCookieName(DROPBOX_SPEC), 'dropbox_oauth_state');
  assert.equal(refreshCookieName(ONEDRIVE_SPEC), 'onedrive_refresh');
  assert.equal(redirectUriFor(DROPBOX_SPEC, 'https://ifclite.com/api/dropbox/auth-start'), 'https://ifclite.com/api/dropbox/auth-callback');
  assert.equal(redirectUriFor(ONEDRIVE_SPEC, 'https://ifclite.com/api/onedrive/auth-start'), 'https://ifclite.com/api/onedrive/auth-callback');
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('cookie parse/serialize round-trips and respects options', () => {
  const cookie = serializeCookie('foo', 'a b/c', { httpOnly: true, secure: true, maxAge: 60, path: '/x', sameSite: 'Lax' });
  assert.match(cookie, /^foo=a%20b%2Fc/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
  assert.match(cookie, /Path=\/x/);
  assert.match(cookie, /SameSite=Lax/);

  const parsed = parseCookies('foo=a%20b%2Fc; bar=baz');
  assert.equal(parsed.foo, 'a b/c');
  assert.equal(parsed.bar, 'baz');
});

test('exchangeCodeForTokens posts the right grant and parses tokens', async () => {
  const { fetch: f, calls } = stubFetch([tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'bearer' })]);
  const tokens = await exchangeCodeForTokens(DROPBOX_SPEC, f, CONFIG, { code: 'code123', redirectUri: 'https://app/cb' });
  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.refresh_token, 'rt');
  assert.equal(calls[0].url, DROPBOX_SPEC.tokenUrl);
  const body = String(calls[0].init?.body ?? '');
  assert.match(body, /grant_type=authorization_code/);
  assert.match(body, /code=code123/);
  assert.match(body, /client_secret=client-secret/);
});

test('refreshAccessToken throws OAuthTokenError on failure', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ error: 'invalid_grant' }, 400)]);
  await assert.rejects(() => refreshAccessToken(ONEDRIVE_SPEC, f, CONFIG, 'rt'), (err: unknown) => {
    assert.ok(err instanceof OAuthTokenError);
    assert.equal(err.status, 400);
    return true;
  });
});

test('authCallback HTML-escapes an attacker-supplied ?error= value (XSS guard)', async () => {
  const handlers = createOAuthHandlers({ spec: DROPBOX_SPEC, config: CONFIG, fetchImpl: stubFetch([]).fetch });
  const malicious = '<script>alert(1)</script>';
  const req = new Request(`https://ifclite.com/api/dropbox/auth-callback?error=${encodeURIComponent(malicious)}`);
  const res = await handlers.authCallback(req);
  assert.equal(res.status, 400);
  const body = await res.text();
  // The raw payload must never appear verbatim (sanitizeMessage strips <>/
  // before either escapeHtml or the JS string embed sees it).
  assert.ok(!body.includes(malicious));
  assert.ok(!body.includes('<script>alert'));
});

// ── Handlers (parametrised over both providers) ──────────────────────────────

for (const spec of [DROPBOX_SPEC, ONEDRIVE_SPEC] as OAuthProviderSpec[]) {
  const STATE = stateCookieName(spec);
  const REFRESH = refreshCookieName(spec);
  const base = `https://ifclite.com/api/${spec.id}`;

  test(`[${spec.id}] authStart redirects to the provider and sets a state cookie`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, makeState: () => 'STATE123', fetchImpl: stubFetch([]).fetch });
    const res = await handlers.authStart(new Request(`${base}/auth-start`));
    assert.equal(res.status, 302);
    const location = res.headers.get('Location') ?? '';
    assert.ok(location.startsWith(spec.authorizeUrl));
    assert.match(location, /state=STATE123/);
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    assert.match(setCookie, new RegExp(`${STATE}=STATE123`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, new RegExp(`Path=/api/${spec.id}`));
  });

  test(`[${spec.id}] authCallback rejects a mismatched state`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const req = new Request(`${base}/auth-callback?code=c&state=evil`, { headers: { cookie: `${STATE}=expected` } });
    const res = await handlers.authCallback(req);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid_state/);
  });

  test(`[${spec.id}] authCallback exchanges code and stores the refresh cookie`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'bearer' })]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/auth-callback?code=c&state=ok`, { headers: { cookie: `${STATE}=ok` } });
    const res = await handlers.authCallback(req);
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => new RegExp(`${REFRESH}=rt`).test(c) && /HttpOnly/.test(c)));
    assert.ok(cookies.some((c) => new RegExp(`${STATE}=`).test(c) && /Max-Age=0/.test(c)));
    assert.match(await res.text(), /auth-result/); // popup signalling script present
  });

  test(`[${spec.id}] authCallback reports a missing refresh token`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ access_token: 'at', expires_in: 14400, token_type: 'bearer' })]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/auth-callback?code=c&state=ok`, { headers: { cookie: `${STATE}=ok` } });
    const res = await handlers.authCallback(req);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /no_refresh_token/);
  });

  test(`[${spec.id}] token returns 401 when no refresh cookie is present`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const res = await handlers.token(new Request(`${base}/token`, { method: 'POST' }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'not_connected' });
  });

  test(`[${spec.id}] token mints an access token from the refresh cookie`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ access_token: 'fresh', expires_in: 3600, token_type: 'bearer' })]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/token`, { method: 'POST', headers: { cookie: `${REFRESH}=rt` } });
    const res = await handlers.token(req);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { access_token: 'fresh', expires_in: 3600, account_id: null });
  });

  test(`[${spec.id}] token clears the cookie when the refresh token is rejected`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ error: 'invalid_grant' }, 400)]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/token`, { method: 'POST', headers: { cookie: `${REFRESH}=stale` } });
    const res = await handlers.token(req);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
  });

  test(`[${spec.id}] token keeps the refresh cookie and returns a retryable status on a provider 5xx`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ error: 'internal' }, 500)]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/token`, { method: 'POST', headers: { cookie: `${REFRESH}=rt` } });
    const res = await handlers.token(req);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Set-Cookie'), null, 'a transient failure must not clear a valid refresh token');
  });

  test(`[${spec.id}] token keeps the refresh cookie and returns a retryable status on a network/timeout failure`, async () => {
    const f = (async () => { throw new Error('network down'); }) as typeof fetch;
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/token`, { method: 'POST', headers: { cookie: `${REFRESH}=rt` } });
    const res = await handlers.token(req);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Set-Cookie'), null, 'a network failure must not clear a valid refresh token');
  });

  test(`[${spec.id}] token rejects a non-POST method without touching the cookie`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const req = new Request(`${base}/token`, { method: 'GET', headers: { cookie: `${REFRESH}=rt` } });
    const res = await handlers.token(req);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  test(`[${spec.id}] token rejects a cross-origin POST`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const req = new Request(`${base}/token`, {
      method: 'POST',
      headers: { cookie: `${REFRESH}=rt`, origin: 'https://evil.example' },
    });
    const res = await handlers.token(req);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  test(`[${spec.id}] token accepts a same-origin POST`, async () => {
    const { fetch: f } = stubFetch([tokenResponse({ access_token: 'fresh', expires_in: 3600, token_type: 'bearer' })]);
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: f });
    const req = new Request(`${base}/token`, {
      method: 'POST',
      headers: { cookie: `${REFRESH}=rt`, origin: 'https://ifclite.com' },
    });
    const res = await handlers.token(req);
    assert.equal(res.status, 200);
  });

  test(`[${spec.id}] disconnect clears the refresh cookie`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const res = await handlers.disconnect(new Request(`${base}/disconnect`, { method: 'POST' }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Set-Cookie') ?? '', new RegExp(`${REFRESH}=`));
    assert.match(res.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
  });

  test(`[${spec.id}] disconnect rejects a GET (a top-level navigation must not be able to log the user out)`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const res = await handlers.disconnect(new Request(`${base}/disconnect`, { method: 'GET' }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Set-Cookie'), null, 'a rejected GET must not emit a Set-Cookie');
  });

  test(`[${spec.id}] disconnect rejects a cross-origin POST`, async () => {
    const handlers = createOAuthHandlers({ spec, config: CONFIG, fetchImpl: stubFetch([]).fetch });
    const req = new Request(`${base}/disconnect`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    const res = await handlers.disconnect(req);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });
}

test('OneDrive: token persists a rotated refresh token when the provider returns a new one', async () => {
  const { fetch: f } = stubFetch([
    tokenResponse({ access_token: 'fresh', refresh_token: 'rotated-rt', expires_in: 3600, token_type: 'bearer' }),
  ]);
  const handlers = createOAuthHandlers({ spec: ONEDRIVE_SPEC, config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/onedrive/token', {
    method: 'POST',
    headers: { cookie: 'onedrive_refresh=old-rt' },
  });
  const res = await handlers.token(req);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie') ?? '', /onedrive_refresh=rotated-rt/);
  assert.match(res.headers.get('Set-Cookie') ?? '', /HttpOnly/);
});

test('OneDrive: token does not rewrite the cookie when the provider returns the same refresh token', async () => {
  const { fetch: f } = stubFetch([
    tokenResponse({ access_token: 'fresh', refresh_token: 'same-rt', expires_in: 3600, token_type: 'bearer' }),
  ]);
  const handlers = createOAuthHandlers({ spec: ONEDRIVE_SPEC, config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/onedrive/token', {
    method: 'POST',
    headers: { cookie: 'onedrive_refresh=same-rt' },
  });
  const res = await handlers.token(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Set-Cookie'), null);
});

test('Dropbox: token does not attempt to rotate the cookie (Dropbox never returns refresh_token on refresh)', async () => {
  const { fetch: f } = stubFetch([tokenResponse({ access_token: 'fresh', expires_in: 3600, token_type: 'bearer' })]);
  const handlers = createOAuthHandlers({ spec: DROPBOX_SPEC, config: CONFIG, fetchImpl: f });
  const req = new Request('https://ifclite.com/api/dropbox/token', {
    method: 'POST',
    headers: { cookie: 'dropbox_refresh=rt' },
  });
  const res = await handlers.token(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Set-Cookie'), null);
});
