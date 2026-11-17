/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF connection to buildagil's openCDE API. buildagil has no `/1.0/auth`
 * and no `current-user`, serves its routes under `1.0`, and sends no CORS
 * headers to most origins (all measured live, 2026-11-02). The fake below is
 * that server, and `/api/buildagil` on this origin runs the REAL relay
 * handler in front of it: a request the viewer sends straight to buildagil
 * fails the test.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bcfOAuthRedirectUri,
  clearBcfServerConfig,
  completeBcfOAuth,
  connectedTokenSource,
  createConnectedClient,
  loadBcfServerConfig,
  prepareBcfOAuth,
  pullBcfServerProject,
  saveBcfServerConfig,
} from './bcf-server.js';
import { createBuildagilRelayHandler, loadBuildagilRelayConfig } from '../../../../server/sources/buildagil-relay.js';

const realFetch = globalThis.fetch;
const API = 'https://openapi.buildagil.com';
const CLIENT_ID = 'client-public-1';

const jwt = (claims: Record<string, unknown>) =>
  `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;
const ACCESS = jwt({ email: 'ana@example.ch', upn: 'ana@example.ch', oid: 'o-1' });
const REFRESHED = jwt({ email: 'ana@example.ch', oid: 'o-1', v: 2 });

interface FakeBuildagil { tokenForms: URLSearchParams[]; upstream: string[]; direct: string[]; topicQueries: URLSearchParams[] }

/** 150 topics, two per second, so a 100-topic page boundary splits a tie. */
const TOPICS = Array.from({ length: 150 }, (_, i) => ({
  guid: `0002d584-0100-${String(i).padStart(4, '0')}-0000-000000000000`,
  title: `Topic ${i}`, topic_type: 'Task', topic_status: 'Open',
  creation_date: '2026-11-01T00:00:00Z',
  modified_date: new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(i / 2))).toISOString().replace('.000Z', 'Z'),
}));

/** The topic list as buildagil serves it: `$skip` ignored; `$filter` (modified_date ge), `$orderby`, `$top` honoured. */
function topicPage(query: URLSearchParams): unknown[] {
  const after = /modified_date ge (\S+)/.exec(query.get('$filter') ?? '')?.[1];
  const ordered = TOPICS.filter((t) => !after || t.modified_date >= after)
    .sort((a, b) => a.modified_date.localeCompare(b.modified_date));
  return ordered.slice(0, Number(query.get('$top') ?? 100));
}

function installFakeBuildagil(): FakeBuildagil {
  const state: FakeBuildagil = { tokenForms: [], upstream: [], direct: [], topicQueries: [] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const relay = createBuildagilRelayHandler(
    loadBuildagilRelayConfig({
      BUILDAGIL_CLIENT_ID: CLIENT_ID,
      BUILDAGIL_REDIRECT_URIS: bcfOAuthRedirectUri(),
      BUILDAGIL_RELAY_ALLOWED_ORIGINS: window.location.origin,
    }),
    {
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        state.upstream.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/oauth2/token') {
          const form = new URLSearchParams(String(init?.body));
          state.tokenForms.push(form);
          if (form.get('client_secret') !== null) return json({ error: 'invalid_client' }, 400);
          if (form.get('grant_type') === 'refresh_token') return json({ access_token: REFRESHED, refresh_token: 'rt-2', expires_in: 3600 });
          return json({ access_token: ACCESS, refresh_token: 'rt-1', expires_in: 3600 });
        }
        const auth = new Headers(init?.headers).get('authorization');
        if (auth !== `Bearer ${ACCESS}` && auth !== `Bearer ${REFRESHED}`) return json({ message: 'error occurred' }, 401);
        if (url.pathname === '/1.0/projects') return json([{ project_id: '185732', name: 'Testprojekt IFClite' }]);
        if (url.pathname === '/1.0/projects/185732') return json({ project_id: '185732', name: 'Testprojekt IFClite' });
        if (url.pathname === '/1.0/projects/185732/extensions') {
          return json({ topic_type: ['Task', 'Model Issue', 'Information'], topic_status: ['Draft', 'Open', 'Closed'], topic_label: [], users: ['ana@example.ch'] });
        }
        if (url.pathname === '/1.0/projects/185732/topics') { state.topicQueries.push(url.searchParams); return json(topicPage(url.searchParams)); }
        if (/\/topics\/[^/]+\/(comments|viewpoints)$/.test(url.pathname)) return json([]);
        return json({ statusCode: 404 }, 404);
      },
    },
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/buildagil/')) {
      const request = new Request(url, { method: init?.method, headers: init?.headers, body: init?.body });
      // What a browser adds to a same-origin request; forbidden header names,
      // so they are set on the built request.
      request.headers.set('origin', window.location.origin);
      request.headers.set('sec-fetch-site', 'same-origin');
      return relay(request);
    }
    state.direct.push(url.href);
    return json({ message: 'no CORS: the browser cannot reach this' }, 599);
  }) as typeof fetch;
  return state;
}

async function signIn() {
  const preparation = await prepareBcfOAuth(API, { clientId: CLIENT_ID, scope: 'openid offline_access api' });
  return { preparation, config: await completeBcfOAuth(preparation, `${bcfOAuthRedirectUri()}?code=code-1&state=${preparation.state}`) };
}

beforeEach(() => { clearBcfServerConfig(); });
afterEach(() => { globalThis.fetch = realFetch; clearBcfServerConfig(); });

describe('BCF connection to buildagil', () => {
  it('prepares sign-in from the known endpoints: no discovery request', async () => {
    const fake = installFakeBuildagil();
    const preparation = await prepareBcfOAuth(API, { clientId: CLIENT_ID, scope: 'openid offline_access api' });
    const authorize = new URL(preparation.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${API}/oauth2/authorize`);
    assert.equal(authorize.searchParams.get('scope'), 'openid offline_access api');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(preparation.tokenUrl, `${API}/oauth2/token`);
    assert.deepEqual([...fake.upstream, ...fake.direct], []);
  });

  it('exchanges the code through the relay as a public client and names the account from the token', async () => {
    const fake = installFakeBuildagil();
    const { config } = await signIn();
    assert.equal(config.serverUrl, API);
    assert.equal(config.userId, 'ana@example.ch');
    assert.equal(config.tokenRelay, '');
    assert.equal(loadBcfServerConfig()?.accessToken, ACCESS);
    const form = fake.tokenForms[0];
    assert.deepEqual([...form.keys()].sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    assert.equal(form.get('client_id'), CLIENT_ID);
    assert.deepEqual(fake.direct, []);
  });

  it('the connected client reads version 1.0 routes through the relay', async () => {
    const fake = installFakeBuildagil();
    await signIn();
    const client = await createConnectedClient();
    const projects = await client.getProjects();
    assert.deepEqual(projects.map((p) => p.name), ['Testprojekt IFClite']);
    assert.ok(fake.upstream.includes('GET /1.0/projects'));
    assert.deepEqual(fake.direct, []);
  });

  it('refreshes an expiring token through the relay with the refresh grant', async () => {
    const fake = installFakeBuildagil();
    const { config } = await signIn();
    saveBcfServerConfig({ ...config, tokenExpiresAt: Date.now() - 1000 });
    const token = await connectedTokenSource(loadBcfServerConfig()!).getAccessToken();
    assert.equal(token, REFRESHED);
    const refresh = fake.tokenForms.at(-1)!;
    assert.deepEqual([...refresh.keys()].sort(), ['client_id', 'grant_type', 'refresh_token']);
    assert.equal(loadBcfServerConfig()?.refreshToken, 'rt-2');
    assert.deepEqual(fake.direct, []);
  });

  it('pulls every topic past the first page although buildagil ignores $skip', async () => {
    const fake = installFakeBuildagil();
    await signIn();
    const result = await pullBcfServerProject('185732', 'Testprojekt IFClite');
    assert.equal(result.project.topics.size, 150);
    assert.equal(result.project.name, 'Testprojekt IFClite');
    // Paged by modified_date, never by $skip.
    assert.ok(fake.topicQueries.length >= 2);
    assert.ok(fake.topicQueries.every((q) => !q.has('$skip') && q.get('$orderby') === 'modified_date asc'));
    assert.match(fake.topicQueries[1].get('$filter') ?? '', /^modified_date ge 2026-11-01T00:00:49Z$/);
    assert.equal(loadBcfServerConfig()?.projectId, '185732');
    assert.deepEqual(fake.direct, []);
  });

  it('an unprofiled server still discovers its endpoints as before', async () => {
    const fake = installFakeBuildagil();
    await assert.rejects(prepareBcfOAuth('https://bcf.example.com/bcf', { clientId: 'x' }));
    assert.ok(fake.direct.some((url) => url.startsWith('https://bcf.example.com/bcf/')));
  });
});
