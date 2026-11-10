/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from '@/test/race';
import { clearBcfServerConfig, loadBcfServerConfig, saveBcfServerConfig, signInToBcfServer,
  signInWithToken, signInWithClientCredentials, completeBcfOAuth, prepareBcfOAuth, createConnectedClient, pullBcfServerProject } from './bcf-server';
import type { BcfOAuthPreparation } from './bcf-server-oauth';
const realFetch = globalThis.fetch;
const baseUrl = 'https://fake.example/bcf';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const connection = () => ({ serverUrl: baseUrl, userId: 'tester@example.com', accessToken: 'token-1', refreshToken: 'refresh-1',
  tokenExpiresAt: 0, clientId: '', clientSecret: '', tokenRelay: '', projectId: 'previous', projectName: 'Previously selected' });
function server(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/auth')) return json({ oauth2_token_url: baseUrl+'/oauth2/token' });
  if (path.endsWith('/token')) return json({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600 });
  if (path.endsWith('/current-user')) return json({ id: 'tester@example.com' });
  if (path.endsWith('/extensions')) return json({ topic_status: [] });
  if (path.endsWith('/topics')) return json([]);
  return json({ project_id: 'p1', name: 'Project One' });
}
beforeEach(() => clearBcfServerConfig());
afterEach(() => { globalThis.fetch = realFetch; clearBcfServerConfig(); });

for (const method of ['password', 'token', 'client credentials'] as const) {
  it(`PR #9583 B1: cancelled ${method} identity decoding cannot persist a connection`, async () => {
    const held = deferred<void>(), started = deferred<void>(), controller = new AbortController();
    let identitySignal: AbortSignal | null | undefined;
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = async (input, init) => {
      signals.push(init?.signal);
      const response = server(input);
      if (new URL(String(input)).pathname.endsWith('/current-user')) {
        identitySignal = init?.signal;
        response.json = async () => { started.resolve(); await held.promise; return { id: 'tester@example.com' }; };
      }
      return response;
    };
    const task = method === 'password' ? signInToBcfServer(baseUrl, 'tester@example.com', 'right', controller.signal)
      : method === 'token' ? signInWithToken(baseUrl, 'token-1', controller.signal)
      : signInWithClientCredentials(baseUrl, 'app', 'secret', controller.signal);
    try {
      await started.promise; controller.abort(); held.resolve();
      await assert.rejects(task, { name: 'AbortError' });
      assert.equal(loadBcfServerConfig() === null, true);
      assert.equal(identitySignal?.aborted, true);
      assert.equal(signals.every(signal => signal?.aborted), true, 'discovery, token and identity requests all receive cancellation');
    } finally { held.resolve(); await task.catch(() => undefined); }
  });
}

for (const relay of ['', '/api/bcf/oauth/token']) {
  it(`PR #9583 B1: OAuth ${relay ? 'relay' : 'direct'} token exchange receives cancellation`, async () => {
    const held = deferred<void>(), started = deferred<void>(), controller = new AbortController();
    let tokenSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (input, init) => {
      const response = server(input);
      if (new URL(String(input)).pathname.endsWith('/token')) { tokenSignal = init?.signal; started.resolve(); await held.promise; }
      return response;
    };
    const preparation: BcfOAuthPreparation = { serverUrl: baseUrl, tokenUrl: baseUrl+'/oauth2/token', authorizeUrl: 'https://fake.example/authorize',
      state: 'state', codeVerifier: 'verifier', clientId: 'app', clientSecret: '', redirectUri: window.location.origin+'/oauth/bcf/callback', tokenRelay: relay };
    const task = completeBcfOAuth(preparation, preparation.redirectUri+'?code=good&state=state', controller.signal);
    try {
      await started.promise; controller.abort(); held.resolve();
      await assert.rejects(task, { name: 'AbortError' });
      assert.equal(tokenSignal?.aborted, true, 'the real relay must forward the run signal to fetch');
      assert.equal(loadBcfServerConfig() === null, true);
    } finally { held.resolve(); await task.catch(() => undefined); }
  });
}

it('PR #9583: an already-cancelled token sign-in dispatches no identity request', async () => {
  const controller = new AbortController(); controller.abort(); let requests = 0;
  globalThis.fetch = async input => { requests++; return server(input); };
  await assert.rejects(signInWithToken('https://fake.example', 'token-1', controller.signal), { name: 'AbortError' });
  assert.equal(requests, 0);
});

it('PR #9583 N3: an ignored abort followed by a late 401 cannot start a token refresh', async () => {
  saveBcfServerConfig(connection());
  const held = deferred<void>(), started = deferred<void>(), controller = new AbortController(); let grants = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/projects/p1')) { started.resolve(); await held.promise; return json({ message: 'expired' }, 401); }
    if (path.endsWith('/token')) grants++;
    return server(input);
  };
  const task = pullBcfServerProject('p1', 'Project One', undefined, controller.signal);
  try {
    await started.promise; controller.abort(); held.resolve();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(grants, 0, 'cancellation stops later HTTP work, including a refresh after 401');
    assert.equal(loadBcfServerConfig()?.projectId, 'previous');
  } finally { held.resolve(); await task.catch(() => undefined); }
});

for (const source of ['run', 'request'] as const) it(`PR #9583: connected clients retain ${source} cancellation`, async () => {
  saveBcfServerConfig(connection());
  const run = new AbortController(), request = new AbortController(), started = deferred<void>(), held = deferred<void>();
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => { seen = init?.signal; started.resolve(); await held.promise; return json({ project_id: 'p1' }); };
  const client = await createConnectedClient(run.signal);
  const task = client.getProject('p1', { signal: request.signal });
  try {
    await started.promise;
    (source === 'run' ? run : request).abort();
    assert.equal(seen?.aborted, true, 'binding a run must retain the per-request signal');
  } finally { held.resolve(); await task.catch(() => undefined); }
});


it('PR #9583: cancelling dynamic OAuth registration aborts its HTTP request', async () => {
  const held = deferred<void>(), started = deferred<void>(), controller = new AbortController();
  let registrationSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/auth')) return json({ oauth2_token_url: baseUrl+'/oauth2/token', oauth2_auth_url: 'https://fake.example/authorize', oauth2_dynamic_client_reg_url: baseUrl+'/register' });
    registrationSignal = init?.signal; started.resolve(); await held.promise;
    return json({ client_id: 'registered' });
  };
  const task = prepareBcfOAuth(baseUrl, { signal: controller.signal });
  try {
    await started.promise; controller.abort(); held.resolve();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(registrationSignal?.aborted, true);
  } finally { held.resolve(); await task.catch(() => undefined); }
});
