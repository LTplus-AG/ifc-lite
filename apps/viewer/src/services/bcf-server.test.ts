/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF server connection service: URL validation, corrupted-storage
 * degradation, the password-grant sign-in flow, and the transparent
 * refresh of an expired access token. The BCF server is faked at the
 * global fetch boundary, so everything from `@ifc-lite/bcf-api`'s request
 * building through this service's persistence runs for real.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bcfOAuthRedirectUri,
  clearBcfServerConfig,
  completeBcfOAuth,
  createConnectedClient,
  listBcfServerProjects,
  loadBcfServerConfig,
  prepareBcfOAuth,
  pullBcfServerProject,
  saveBcfServerConfig,
  signInToBcfServer,
  signInWithClientCredentials,
  signInWithToken,
  subscribeBcfServer,
  validateBcfServerUrl,
} from './bcf-server.js';

const realFetch = globalThis.fetch;

interface FakeServerState {
  /** Tokens the fake currently accepts on data routes. */
  validTokens: Set<string>;
  /** grant_type values seen at the token endpoint, in order. */
  grants: string[];
  /** When set, the token endpoint awaits this before answering. */
  tokenGate?: Promise<void>;
  /** When set, /auth advertises this token endpoint instead of the default. */
  advertisedTokenUrl?: string;
  /** When set, /auth advertises this registration endpoint instead of the default. */
  advertisedRegistrationUrl?: string;
  /** When false, /auth omits the dynamic client registration URL. */
  dynamicRegistration?: boolean;
  /** Registration requests seen, for asserting what was sent. */
  registrations: Array<Record<string, unknown>>;
}

/** Fake BCF server at the fetch boundary: auth discovery, OAuth2, projects. */
function installFakeServer(): FakeServerState {
  const state: FakeServerState = {
    validTokens: new Set(['token-1']),
    grants: [],
    registrations: [],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/bcf/2.1/auth') {
      return json({
        oauth2_auth_url: 'https://fake.example/bcf/oauth2/auth',
        oauth2_token_url: state.advertisedTokenUrl ?? 'https://fake.example/bcf/oauth2/token',
        oauth2_dynamic_client_reg_url:
          state.dynamicRegistration === false
            ? undefined
            : (state.advertisedRegistrationUrl ?? 'https://fake.example/bcf/oauth2/register'),
      });
    }
    if (url.pathname === '/bcf/oauth2/register') {
      state.registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ client_id: 'minted-id', client_secret: 'minted-secret' });
    }
    if (url.pathname === '/bcf/oauth2/token') {
      if (state.tokenGate) await state.tokenGate;
      const form = new URLSearchParams(String(init?.body));
      state.grants.push(form.get('grant_type') ?? '');
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier')) {
          return json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
        }
      }
      if (form.get('grant_type') === 'password' && form.get('password') !== 'right') {
        return json({ error: 'invalid_grant', error_description: 'bad credentials' }, 400);
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== 'refresh-1') {
        return json({ error: 'invalid_grant', error_description: 'bad refresh token' }, 400);
      }
      if (
        form.get('grant_type') === 'client_credentials' &&
        (form.get('client_id') !== 'app-id' || form.get('client_secret') !== 'app-secret')
      ) {
        return json({ error: 'invalid_client', error_description: 'bad app credentials' }, 401);
      }
      const token = `token-${state.grants.length}`;
      state.validTokens.add(token);
      return json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
      });
    }
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!state.validTokens.has(auth.replace('Bearer ', ''))) {
      return json({ message: 'Not authenticated' }, 401);
    }
    if (url.pathname === '/bcf/2.1/current-user') {
      return json({ id: 'tester@example.com', name: 'Tester' });
    }
    if (url.pathname === '/bcf/2.1/projects') {
      return json([{ project_id: 'p1', name: 'Project One' }]);
    }
    return json({ message: `unhandled ${url.pathname}` }, 500);
  }) as typeof fetch;
  return state;
}

beforeEach(() => {
  clearBcfServerConfig();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearBcfServerConfig();
});

describe('validateBcfServerUrl', () => {
  it('requires https except for local development hosts', () => {
    assert.equal(validateBcfServerUrl('https://example.com/bcf'), null);
    assert.equal(validateBcfServerUrl('http://localhost:8080/bcf'), null);
    assert.equal(validateBcfServerUrl('http://127.0.0.1/bcf'), null);
    assert.match(validateBcfServerUrl('http://example.com/bcf') ?? '', /https/);
    assert.match(validateBcfServerUrl('not a url') ?? '', /full server URL/);
  });
});

describe('loadBcfServerConfig', () => {
  it('degrades corrupted or partial storage to signed-out, never throws', () => {
    localStorage.setItem('ifc-lite:bcf-server:v1', '{not json');
    assert.equal(loadBcfServerConfig(), null);
    // A record without an access token is a broken session, not a connection.
    localStorage.setItem('ifc-lite:bcf-server:v1', JSON.stringify({ serverUrl: 'https://x' }));
    assert.equal(loadBcfServerConfig(), null);
  });
});

describe('clearBcfServerConfig', () => {
  it('still notifies subscribers when browser storage is blocked', () => {
    const storagePrototype = Object.getPrototypeOf(localStorage) as object;
    const descriptor = Object.getOwnPropertyDescriptor(storagePrototype, 'removeItem');
    assert.ok(descriptor);
    const originalWarn = console.warn;
    let changes = 0;
    const onChange = () => {
      changes += 1;
    };
    Object.defineProperty(storagePrototype, 'removeItem', {
      configurable: true,
      value: () => {
        throw new Error('storage blocked');
      },
    });
    console.warn = () => {};
    window.addEventListener('ifc-lite:bcf-server-changed', onChange);
    try {
      assert.doesNotThrow(() => clearBcfServerConfig());
      assert.equal(changes, 1);
    } finally {
      window.removeEventListener('ifc-lite:bcf-server-changed', onChange);
      console.warn = originalWarn;
      Object.defineProperty(storagePrototype, 'removeItem', descriptor);
    }
  });
});

describe('signInToBcfServer', () => {
  it('discovers the token endpoint, exchanges the password grant, and persists the session', async () => {
    const server = installFakeServer();
    const config = await signInToBcfServer(
      'https://fake.example/bcf/2.1/',
      'tester@example.com',
      'right',
    );
    assert.equal(config.serverUrl, 'https://fake.example/bcf');
    assert.equal(config.userId, 'tester@example.com');
    assert.equal(config.refreshToken, 'refresh-1');
    assert.ok(config.tokenExpiresAt > Date.now());
    assert.deepEqual(server.grants, ['password']);
    // The persisted session drives later requests.
    const projects = await listBcfServerProjects();
    assert.equal(projects[0]?.name, 'Project One');
  });

  it('surfaces the server rejection message and stores nothing', async () => {
    installFakeServer();
    await assert.rejects(
      signInToBcfServer('https://fake.example/bcf', 'tester@example.com', 'wrong'),
      /bad credentials/,
    );
    assert.equal(loadBcfServerConfig(), null);
  });
});

describe('signInWithToken', () => {
  it('validates a pasted token against current-user and persists a token-only session', async () => {
    const server = installFakeServer();
    server.validTokens.add('pasted-token');
    const config = await signInWithToken('https://fake.example/bcf/', '  pasted-token  ');
    assert.equal(config.userId, 'tester@example.com');
    assert.equal(config.accessToken, 'pasted-token');
    assert.equal(config.refreshToken, '');
    assert.equal(config.tokenExpiresAt, 0);
    assert.deepEqual(server.grants, [], 'no token endpoint involvement');
    const projects = await listBcfServerProjects();
    assert.equal(projects.length, 1);
  });

  it('rejects a token the server does not accept and stores nothing', async () => {
    installFakeServer();
    await assert.rejects(
      signInWithToken('https://fake.example/bcf', 'made-up-token'),
      /Not authenticated/,
    );
    assert.equal(loadBcfServerConfig(), null);
  });
});

describe('signInWithClientCredentials', () => {
  it('exchanges the app credentials and persists them for later re-grants', async () => {
    const server = installFakeServer();
    const config = await signInWithClientCredentials(
      'https://fake.example/bcf',
      'app-id',
      'app-secret',
    );
    assert.equal(config.userId, 'tester@example.com');
    assert.equal(config.clientId, 'app-id');
    assert.equal(config.clientSecret, 'app-secret');
    assert.deepEqual(server.grants, ['client_credentials']);
  });

  it('surfaces bad app credentials and stores nothing', async () => {
    installFakeServer();
    await assert.rejects(
      signInWithClientCredentials('https://fake.example/bcf', 'app-id', 'wrong-secret'),
      /bad app credentials/,
    );
    assert.equal(loadBcfServerConfig(), null);
  });

  it('re-grants an expired token with the stored app credentials (no refresh token)', async () => {
    const server = installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'expired-token',
      refreshToken: '',
      tokenExpiresAt: Date.now() - 1000,
      clientId: 'app-id',
      clientSecret: 'app-secret',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const projects = await client.getProjects();
    assert.equal(projects.length, 1);
    assert.deepEqual(server.grants, ['client_credentials']);
    const stored = loadBcfServerConfig();
    assert.notEqual(stored?.accessToken, 'expired-token');
    assert.equal(stored?.clientId, 'app-id', 'app credentials survive the re-grant');
  });
});

describe('createConnectedClient token refresh', () => {
  it('refreshes an expired access token before the request and persists the new token set', async () => {
    const server = installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() - 1000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const projects = await client.getProjects();
    assert.equal(projects.length, 1, 'request succeeds on the refreshed token');
    assert.deepEqual(server.grants, ['refresh_token']);
    const stored = loadBcfServerConfig();
    assert.notEqual(stored?.accessToken, 'expired-token');
    assert.ok(stored && stored.tokenExpiresAt > Date.now());
  });

  it('uses the stored token as-is while it is still fresh', async () => {
    const server = installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    await client.getProjects();
    assert.deepEqual(server.grants, [], 'no token round-trip for a fresh session');
  });

  it('recovers from a 401 by refreshing once and retrying (server omitted expires_in)', async () => {
    // The stored token looks fresh by the clock but the server has revoked
    // it; the 401 answer must trigger one refresh-and-retry, not an error.
    const server = installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'revoked-server-side',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const projects = await client.getProjects();
    assert.equal(projects.length, 1);
    assert.deepEqual(server.grants, ['refresh_token']);
  });

  it('does not write a stale refresh over a different account on the same server', async () => {
    const server = installFakeServer();
    let openGate = () => {};
    server.tokenGate = new Promise((resolve) => {
      openGate = resolve;
    });
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'old-account@example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() - 1000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const pending = client.getProjects();
    // A different account signs in on the SAME server while the old
    // account's refresh is still in flight.
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'new-account@example.com',
      accessToken: 'token-1',
      refreshToken: 'refresh-other',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    openGate();
    await pending;
    const stored = loadBcfServerConfig();
    assert.equal(stored?.userId, 'new-account@example.com');
    assert.equal(stored?.accessToken, 'token-1', 'replacement session must keep its own tokens');
    assert.equal(stored?.refreshToken, 'refresh-other');
  });

  it('does not resurrect the session when the user disconnects during a refresh', async () => {
    const server = installFakeServer();
    let openGate = () => {};
    server.tokenGate = new Promise((resolve) => {
      openGate = resolve;
    });
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() - 1000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    const pending = client.getProjects();
    // Sign-out lands while the refresh round-trip is still in flight.
    clearBcfServerConfig();
    openGate();
    await pending;
    assert.equal(loadBcfServerConfig(), null, 'sign-out must survive the completed refresh');
  });

  it('keeps the original account token after another account signs in on the same server', async () => {
    const server = installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'old-account@example.com',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const client = await createConnectedClient();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'new-account@example.com',
      accessToken: 'token-from-other-account',
      refreshToken: 'refresh-other',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const projects = await client.getProjects();
    assert.equal(projects.length, 1, 'original session token must still be accepted');
    assert.deepEqual(server.grants, [], 'must not refresh as the replacement account');
  });
});

describe('prepareBcfOAuth', () => {
  it('builds the authorization URL with PKCE from an explicit client id, skipping registration', async () => {
    const server = installFakeServer();
    const preparation = await prepareBcfOAuth('https://fake.example/bcf', {
      clientId: 'my-app',
      scope: 'openid',
    });
    const url = new URL(preparation.authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://fake.example/bcf/oauth2/auth');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'my-app');
    assert.equal(url.searchParams.get('redirect_uri'), bcfOAuthRedirectUri());
    assert.equal(url.searchParams.get('scope'), 'openid');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.equal(url.searchParams.get('state'), preparation.state);
    assert.equal(server.registrations.length, 0);
  });

  it('mints a client via dynamic registration when no client id is given', async () => {
    const server = installFakeServer();
    const preparation = await prepareBcfOAuth('https://fake.example/bcf');
    assert.equal(preparation.clientId, 'minted-id');
    assert.equal(preparation.clientSecret, 'minted-secret');
    assert.equal(server.registrations.length, 1);
    assert.equal(server.registrations[0].redirect_url, bcfOAuthRedirectUri());
    assert.equal(
      new URL(preparation.authorizeUrl).searchParams.get('client_id'),
      'minted-id',
    );
  });

  it('explains what is needed when the server offers no registration and no id was given', async () => {
    const server = installFakeServer();
    server.dynamicRegistration = false;
    await assert.rejects(prepareBcfOAuth('https://fake.example/bcf'), /needs a Client ID/);
  });

  it('refuses to register a client at a plain-http registration endpoint', async () => {
    const server = installFakeServer();
    server.advertisedRegistrationUrl = 'http://fake.example/bcf/oauth2/register';
    await assert.rejects(
      prepareBcfOAuth('https://fake.example/bcf'),
      /insecure client registration endpoint/,
    );
    assert.equal(server.registrations.length, 0, 'no client secret may be minted over http');
  });
});

describe('completeBcfOAuth', () => {
  it('validates the callback, exchanges the code, and persists the session with app credentials', async () => {
    const server = installFakeServer();
    const preparation = await prepareBcfOAuth('https://fake.example/bcf');
    const callbackUrl = `${bcfOAuthRedirectUri()}?code=good-code&state=${preparation.state}`;
    const config = await completeBcfOAuth(preparation, callbackUrl);
    assert.equal(config.userId, 'tester@example.com');
    assert.equal(config.clientId, 'minted-id');
    assert.equal(config.clientSecret, 'minted-secret');
    assert.deepEqual(server.grants, ['authorization_code']);
    assert.ok(loadBcfServerConfig(), 'session persisted');
  });

  it('rejects a callback whose state does not match this attempt', async () => {
    installFakeServer();
    const preparation = await prepareBcfOAuth('https://fake.example/bcf');
    const forged = `${bcfOAuthRedirectUri()}?code=good-code&state=someone-elses-state`;
    await assert.rejects(completeBcfOAuth(preparation, forged));
    assert.equal(loadBcfServerConfig(), null);
  });
});

describe('subscribeBcfServer', () => {
  it('notifies on the same-window change event and on a storage event for this key', () => {
    let calls = 0;
    const stop = subscribeBcfServer(() => {
      calls += 1;
    });
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'tester@example.com',
      accessToken: 'token-1',
      refreshToken: '',
      tokenExpiresAt: 0,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    assert.equal(calls, 1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'ifc-lite:bcf-server:v1' }));
    assert.equal(calls, 2);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    assert.equal(calls, 2);
    stop();
  });
});

describe('pullBcfServerProject session isolation', () => {
  it('does not persist the pulled project onto a replacement account', async () => {
    installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'old-account@example.com',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      tokenExpiresAt: Date.now() + 3_600_000,
      clientId: '',
      clientSecret: '',
      projectId: '',
      projectName: '',
    });
    const inner = globalThis.fetch;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/topics')) {
        saveBcfServerConfig({
          serverUrl: 'https://fake.example/bcf',
          userId: 'new-account@example.com',
          accessToken: 'token-1',
          refreshToken: 'refresh-other',
          tokenExpiresAt: Date.now() + 3_600_000,
          clientId: '',
          clientSecret: '',
          projectId: '',
          projectName: '',
        });
        return json([]);
      }
      if (path.endsWith('/projects/p1')) return json({ project_id: 'p1', name: 'Project One' });
      if (path.endsWith('/extensions')) return json({});
      if (path.endsWith('/comments') || path.endsWith('/viewpoints')) return json([]);
      return inner(input, init);
    }) as typeof fetch;
    await pullBcfServerProject('p1', 'Project One');
    const stored = loadBcfServerConfig();
    assert.equal(stored?.userId, 'new-account@example.com');
    assert.equal(stored?.projectId, '', 'replacement session must not inherit the other account pull');
  });
});

describe('discovered token endpoint TLS enforcement', () => {
  it('refuses to send the password to a plain-http token endpoint', async () => {
    const server = installFakeServer();
    server.advertisedTokenUrl = 'http://fake.example/bcf/oauth2/token';
    await assert.rejects(
      signInToBcfServer('https://fake.example/bcf', 'tester@example.com', 'right'),
      /insecure token endpoint/,
    );
    assert.deepEqual(server.grants, [], 'no credentials may reach the endpoint');
    assert.equal(loadBcfServerConfig(), null);
  });
});
