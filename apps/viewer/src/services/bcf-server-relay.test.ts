/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIMcollab sign-in through the server token relay (#4919). IFClite's
 * production BIMcollab client is CONFIDENTIAL: its token endpoint answers a
 * code exchange without the client secret with `invalid_client` (measured
 * against a live space, 2026-10-28). The fake below is a BIMcollab space
 * with that behaviour, and `/api/bcf/oauth/token` on this origin runs the
 * REAL relay handler in front of it, so the viewer's request shape, the
 * relay's validation and the 503 fallback contract are exercised together.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bcfOAuthRedirectUri,
  clearBcfServerConfig,
  completeBcfOAuth,
  createConnectedClient,
  loadBcfServerConfig,
  prepareBcfOAuth,
  saveBcfServerConfig,
} from './bcf-server.js';
import {
  createBcfTokenRelayHandler,
  loadBcfTokenRelayConfig,
} from '../../../../server/bcf/oauth-token-relay.js';

const realFetch = globalThis.fetch;
const SPACE = 'https://myspace.bimcollab.com';
const TOKEN_URL = `${SPACE}/identity/connect/token`;
const RELAY = '/api/bcf/oauth/token';
const CLIENT_ID = '4e5649c2-6ea1-4736-8abc-8a91bbefcde3';
const SECRET = 'server-only-secret-sentinel';

interface FakeSpace {
  /** Token-endpoint form bodies the space received, from anyone. */
  tokenForms: URLSearchParams[];
  /** Requests the BROWSER sent straight to the space's token endpoint. */
  directTokenCalls: number;
  /** Requests the browser sent to the relay. */
  relayCalls: number;
}

/**
 * A BIMcollab space whose token endpoint demands the client secret, plus the
 * relay on this origin. `relayEnv` is the relay deployment's env.
 */
function installFakeSpace(
  relayEnv: Record<string, string>,
  options: { confidential?: boolean } = {},
): FakeSpace {
  const confidential = options.confidential ?? true;
  const state: FakeSpace = { tokenForms: [], directTokenCalls: 0, relayCalls: 0 };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const tokenEndpoint = (body: string): Response => {
    const form = new URLSearchParams(body);
    state.tokenForms.push(form);
    if (confidential && (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== SECRET)) {
      return json({ error: 'invalid_client' }, 400);
    }
    const grant = form.get('grant_type');
    if (grant === 'authorization_code' && (form.get('code') !== 'good-code' || !form.get('code_verifier'))) {
      return json({ error: 'invalid_grant' }, 400);
    }
    if (grant === 'refresh_token' && form.get('refresh_token') !== 'refresh-1') {
      return json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400);
    }
    return json({ access_token: 'space-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
  };

  const relay = createBcfTokenRelayHandler(
    loadBcfTokenRelayConfig({ BCF_BIMCOLLAB_REDIRECT_URIS: bcfOAuthRedirectUri(), ...relayEnv }),
    { fetchImpl: async (_input, init) => tokenEndpoint(String(init?.body)) },
  );

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === window.location.origin && url.pathname === RELAY) {
      state.relayCalls += 1;
      const request = new Request(url, { method: init?.method, headers: init?.headers, body: init?.body });
      // What the browser adds to a same-origin POST. They are forbidden
      // header names, so happy-dom's Request constructor drops them and they
      // are set on the built request instead.
      request.headers.set('origin', window.location.origin);
      request.headers.set('sec-fetch-site', 'same-origin');
      return relay(request);
    }
    if (url.href === TOKEN_URL) {
      state.directTokenCalls += 1;
      return tokenEndpoint(String(init?.body));
    }
    if (url.pathname === '/bcf/2.1/auth') {
      return json({
        oauth2_auth_url: `${SPACE}/identity/connect/authorize`,
        oauth2_token_url: TOKEN_URL,
        supported_oauth2_flows: ['authorization_code_grant'],
      });
    }
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== 'Bearer space-token') return json({ message: 'Not authenticated' }, 401);
    if (url.pathname === '/bcf/2.1/current-user') return json({ id: 'tester@example.com', name: 'Tester' });
    if (url.pathname === '/bcf/2.1/projects') return json([{ project_id: 'p1', name: 'Project One' }]);
    return json({ message: `unhandled ${url.pathname}` }, 500);
  }) as typeof fetch;
  return state;
}

const CONFIGURED = { BCF_BIMCOLLAB_CLIENT_ID: CLIENT_ID, BCF_BIMCOLLAB_CLIENT_SECRET: SECRET };

async function signIn(tokenRelay: string | undefined) {
  const preparation = await prepareBcfOAuth(`${SPACE}/bcf`, {
    clientId: CLIENT_ID,
    clientSecret: '',
    scope: 'openid offline_access bcf',
    tokenRelay,
  });
  return completeBcfOAuth(preparation, `${bcfOAuthRedirectUri()}?code=good-code&state=${preparation.state}`);
}

beforeEach(() => {
  clearBcfServerConfig();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearBcfServerConfig();
});

describe('BCF sign-in through the token relay (#4919)', () => {
  it('a confidential client cannot sign in without the relay: the space wants the secret', async () => {
    const space = installFakeSpace(CONFIGURED);
    await assert.rejects(signIn(undefined), /invalid_client/);
    assert.equal(space.directTokenCalls, 1);
    assert.equal(space.relayCalls, 0);
  });

  it('exchanges the code through the relay, which adds the secret, and stores no secret', async () => {
    const space = installFakeSpace(CONFIGURED);
    const config = await signIn(RELAY);

    assert.equal(config.userId, 'tester@example.com');
    assert.equal(space.directTokenCalls, 0, 'the browser never posts to the token endpoint itself');
    assert.equal(space.relayCalls, 1);
    const exchange = space.tokenForms.at(-1);
    assert.ok(exchange);
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('redirect_uri'), bcfOAuthRedirectUri());
    assert.equal(exchange.get('client_secret'), SECRET, 'added server-side');

    const stored = loadBcfServerConfig();
    assert.equal(stored?.tokenRelay, RELAY, 'the session remembers to refresh through the relay');
    assert.equal(stored?.clientSecret, '');
    assert.equal(stored?.clientId, CLIENT_ID);
    const raw = JSON.stringify(stored);
    assert.ok(!raw.includes(SECRET), 'no copy of the secret reaches browser storage');
  });

  it('refreshes a relayed session through the relay too', async () => {
    const space = installFakeSpace(CONFIGURED);
    saveBcfServerConfig({
      serverUrl: `${SPACE}/bcf`,
      userId: 'tester@example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() - 1000,
      clientId: CLIENT_ID,
      clientSecret: '',
      tokenRelay: RELAY,
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const projects = await client.getProjects();

    assert.equal(projects.length, 1, 'the request ran on the refreshed token');
    assert.equal(space.directTokenCalls, 0);
    assert.equal(space.relayCalls, 1);
    assert.equal(space.tokenForms.at(-1)?.get('grant_type'), 'refresh_token');
    assert.equal(loadBcfServerConfig()?.accessToken, 'space-token');
  });

  it('a vendor rejection through the relay surfaces and is not retried directly', async () => {
    const space = installFakeSpace(CONFIGURED);
    saveBcfServerConfig({
      serverUrl: `${SPACE}/bcf`,
      userId: 'tester@example.com',
      accessToken: 'expired-token',
      refreshToken: 'revoked-refresh',
      tokenExpiresAt: Date.now() - 1000,
      clientId: CLIENT_ID,
      clientSecret: '',
      tokenRelay: RELAY,
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    await assert.rejects(client.getProjects(), /refresh token revoked/);
    assert.equal(space.directTokenCalls, 0);
  });

  it('falls back to the direct exchange when the deployment has not configured the relay', async () => {
    // The relay answers 503 relay_not_configured before contacting the
    // vendor, so the code is unspent and the public-client exchange runs as
    // it would without a relay.
    const space = installFakeSpace({}, { confidential: false });
    const config = await signIn(RELAY);

    assert.equal(space.relayCalls, 1);
    assert.equal(space.directTokenCalls, 1);
    assert.equal(space.tokenForms.length, 1, 'the vendor saw the code once');
    assert.equal(space.tokenForms[0].get('client_id'), CLIENT_ID);
    assert.equal(config.tokenRelay, '', 'refreshes go direct, the way the code exchange went');
  });

  it('refuses a relay off this origin, or alongside a browser-held secret, before any request', async () => {
    const space = installFakeSpace(CONFIGURED);
    await assert.rejects(
      prepareBcfOAuth(`${SPACE}/bcf`, { clientId: CLIENT_ID, tokenRelay: 'https://relay.example/token' }),
      /must be on this origin/,
    );
    await assert.rejects(
      prepareBcfOAuth(`${SPACE}/bcf`, { clientId: CLIENT_ID, clientSecret: 'leaked', tokenRelay: RELAY }),
      /must not carry a client secret/,
    );
    await assert.rejects(
      prepareBcfOAuth(`${SPACE}/bcf`, { tokenRelay: RELAY }),
      /needs the client id the relay holds/,
    );
    assert.equal(space.relayCalls + space.directTokenCalls, 0);
  });
});
