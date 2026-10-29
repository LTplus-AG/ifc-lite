/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer binding of the BIMcollab Documents source: it rides on the saved
 * BIMcollab BCF connection, only ever reaches the same-origin relay, and
 * rebinds when the connected account changes.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@ifc-lite/plugin-api';
import type { BcfServerConfig } from '../bcf-server-config.js';
import {
  BimcollabNotConnectedError, ViewerBimcollabProvider, bimcollabSessionFromConfig, relayOnlyFetch, retryUnauthorized,
} from './bimcollab-source.js';

const SPACE = '728fc6a4-92dc-4724-a4d0-fa0e4085d2ee';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

function config(overrides: Partial<BcfServerConfig> = {}): BcfServerConfig {
  return {
    serverUrl: 'https://busa.bimcollab.com/bcf', userId: 'user@example.com',
    accessToken: jwt({ aud: 'bcf', spaceGuid: SPACE }), refreshToken: '', tokenExpiresAt: 0,
    clientId: '', clientSecret: '', tokenRelay: '', projectId: '', projectName: '', ...overrides,
  };
}

// The wrapper never touches ctx (its transport carries its own fetch).
const ctx = {} as PluginContext;

describe('relayOnlyFetch', () => {
  it('refuses anything but the same-origin relay path', async () => {
    const guarded = relayOnlyFetch('https://www.ifclite.com');
    for (const url of ['https://api.eu.bimcollab.com/spaces/x', 'https://evil.test/api/bimcollab/docs', '/api/bimcollabX/docs', '/api/other']) {
      await assert.rejects(guarded(url), /may only call \/api\/bimcollab\//);
    }
  });
});

describe('bimcollabSessionFromConfig', () => {
  it('needs a BIMcollab space URL and a spaceGuid claim', () => {
    assert.deepEqual(
      (({ spaceGuid, spaceLabel }) => ({ spaceGuid, spaceLabel }))(bimcollabSessionFromConfig(config())!),
      { spaceGuid: SPACE, spaceLabel: 'busa' },
    );
    assert.equal(bimcollabSessionFromConfig(null), null);
    assert.equal(bimcollabSessionFromConfig(config({ serverUrl: 'https://api.bimdata.io/bcf' })), null);
    assert.equal(bimcollabSessionFromConfig(config({ accessToken: 'opaque-token' })), null);
  });
});

describe('ViewerBimcollabProvider', () => {
  it('is interactive and explains where to connect when there is no BIMcollab session', async () => {
    const provider = new ViewerBimcollabProvider(() => null, relayOnlyFetch('https://www.ifclite.com'));
    assert.equal(provider.manifest.auth, 'interactive');
    assert.equal(await provider.auth.restore(ctx), null);
    await assert.rejects(provider.auth.signIn(ctx), BimcollabNotConnectedError);
    await assert.rejects(provider.listProjects(ctx), BimcollabNotConnectedError);
  });

  it('lists through the relay with the saved bearer token, and rebinds on account change', async () => {
    let current = config();
    const calls: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return Response.json({ locationGroups: [], locations: [{ locationId: 'loc', name: 'Default', projects: [
        { projectId: 'p1', name: 'BUSA Herisau', projectPhases: [] },
      ] }] });
    }) as typeof fetch;
    const provider = new ViewerBimcollabProvider(() => current, fetchFn);
    assert.deepEqual(await provider.auth.restore(ctx), {
      id: 'user@example.com', displayName: 'user@example.com', email: 'user@example.com', organization: 'busa',
    });
    const page = await provider.listProjects(ctx);
    assert.deepEqual(page.items.map(p => p.name), ['BUSA Herisau']);
    assert.equal(calls[0].url, `/api/bimcollab/docs/${SPACE}/project-structure`);
    assert.equal(calls[0].auth, `Bearer ${current.accessToken}`);

    const other = '00000000-0000-4000-8000-000000000001';
    current = config({ userId: 'other@example.com', accessToken: jwt({ spaceGuid: other }) });
    await provider.listProjects(ctx);
    assert.equal(calls[1].url, `/api/bimcollab/docs/${other}/project-structure`);
    assert.equal(calls[1].auth, `Bearer ${current.accessToken}`);
  });
});

describe('retryUnauthorized', () => {
  it('refreshes once on 401 and retries with the new bearer', async () => {
    const seen: (string | null)[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      seen.push(auth);
      return new Response(null, { status: auth === 'Bearer fresh' ? 200 : 401 });
    }) as typeof fetch;
    let refreshes = 0;
    const response = await retryUnauthorized(fetchFn, async () => { refreshes++; return 'fresh'; })('/api/bimcollab/docs/x', { headers: { Authorization: 'Bearer stale' } });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh']);
    assert.equal(refreshes, 1);
  });

  it('returns the 401 untouched when no refresh is possible, and passes other statuses through', async () => {
    let calls = 0;
    const unauthorized = (async () => { calls++; return new Response(null, { status: 401 }); }) as typeof fetch;
    assert.equal((await retryUnauthorized(unauthorized, async () => null)('/api/bimcollab/x')).status, 401);
    assert.equal(calls, 1);
    const forbidden = (async () => new Response(null, { status: 403 })) as typeof fetch;
    let refreshed = false;
    assert.equal((await retryUnauthorized(forbidden, async () => { refreshed = true; return 'x'; })('/api/bimcollab/x')).status, 403);
    assert.equal(refreshed, false);
  });
});
