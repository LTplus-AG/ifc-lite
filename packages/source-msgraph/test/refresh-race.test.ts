/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Concurrent-refresh de-duplication, end to end through the provider.
 *
 * `TokenManager` serializes refreshes on a *per-instance* `pendingRefresh`
 * promise — which only de-duplicates callers that share one instance. A
 * provider that builds a fresh `TokenManager` per call therefore has that
 * guarantee by name only: two overlapping calls landing while the stored
 * access token is inside the 60 s refresh skew each POST the same refresh
 * token. Microsoft rotates SPA refresh tokens on use, so the second POST is
 * answered `invalid_grant` — and if the loser's write lands last, what gets
 * persisted is derived from a token the server has already retired, which
 * kills the session until the user signs in interactively again.
 *
 * The assertion below is the whole point: N overlapping calls must produce
 * exactly ONE token-endpoint POST.
 */

import { describe, it, expect } from 'vitest';

import { MsGraphProvider } from '../src/provider.js';
import { msGraphAuth } from '../src/auth.js';
import { MOCK_ACCESS_TOKEN, createGraphMockContext } from './msgraph-api-mock.js';
import type { GraphMockWorld } from './msgraph-api-mock.js';

const WORLD: GraphMockWorld = {
  driveId: 'drive-1',
  driveName: 'Contoso Drive',
  items: [
    { id: 'f-alpha', name: 'Alpha', kind: 'folder', childCount: 1 },
    { id: 'file-1', name: 'model.ifc', parentId: 'f-alpha', kind: 'file', size: 12, content: 'MODEL-BYTES-1' },
  ],
};

interface RefreshHarness {
  readonly ctx: ReturnType<typeof createGraphMockContext>;
  /** One entry per POST that actually reached the token endpoint. */
  readonly refreshBodies: string[];
}

/**
 * A context whose stored access token is already expired, and whose `fetch`
 * routes the Microsoft token endpoint to a rotating-refresh-token stand-in:
 * the first POST succeeds and mints a new refresh token, every later POST
 * presenting the retired token is answered `invalid_grant`, exactly as the
 * Microsoft identity platform answers a replayed SPA refresh token.
 */
function createExpiredTokenHarness(): RefreshHarness {
  const base = createGraphMockContext(WORLD);
  const refreshBodies: string[] = [];
  let liveRefreshToken = 'refresh-token-v1';

  const ctx = {
    ...base,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = typeof input === 'string' ? input : input.toString();
      if (!href.includes('/oauth2/v2.0/token')) return base.fetch(input, init);

      const body = String(init?.body ?? '');
      refreshBodies.push(body);
      const presented = new URLSearchParams(body).get('refresh_token');

      // A real network round trip is not instantaneous; the delay widens the
      // window a second caller would race through, so this test would still
      // catch the duplicate POST if the two calls were further apart than a
      // single microtask.
      await new Promise((resolve) => setTimeout(resolve, 5));

      if (presented !== liveRefreshToken) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token has been rotated' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      liveRefreshToken = 'refresh-token-v2';
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: liveRefreshToken,
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch,
  };

  return { ctx, refreshBodies };
}

async function seedExpiredTokens(harness: RefreshHarness): Promise<void> {
  await harness.ctx.storage.set(
    'msgraph:tokens',
    JSON.stringify({
      accessToken: 'stale-access-token',
      refreshToken: 'refresh-token-v1',
      // Inside the 60 s refresh skew — the case the doc comment on
      // `TokenManager.getValidAccessToken` describes.
      expiresAt: Date.now() - 1_000,
    }),
  );
}

// The token manager is shared process-wide per `(clientId, tenant)`, so each
// case needs the cache dropped or the previous one's storage would serve it.
// `createGraphMockContext` does that itself — see its doc comment.
describe('concurrent refresh de-duplication', () => {
  it('collapses two overlapping provider calls onto ONE token-endpoint POST', async () => {
    const provider = new MsGraphProvider();
    const harness = createExpiredTokenHarness();
    await seedExpiredTokens(harness);

    const [projects, containers] = await Promise.all([
      provider.listProjects(harness.ctx),
      provider.listContainers(harness.ctx, 'me'),
    ]);

    expect(harness.refreshBodies).toHaveLength(1);
    expect(new URLSearchParams(harness.refreshBodies[0]).get('grant_type')).toBe('refresh_token');
    // Both calls really did complete against the refreshed token, rather than
    // one of them failing and the count staying at one by accident.
    expect(projects.items).toHaveLength(1);
    expect(containers.items.map((c) => c.id)).toEqual(['f-alpha']);
  });

  it('collapses a listing racing an identity check onto ONE token-endpoint POST', async () => {
    // `getIdentity()` goes through `auth.ts` while a listing goes through
    // `provider.ts`; a manager scoped to the provider instance would leave
    // these two racing. The host really does run them against separate
    // `PluginContext` objects (`SourceHost.createContext` mints a fresh one
    // per operation), which is why the sharing cannot be keyed on `ctx`.
    const provider = new MsGraphProvider();
    const harness = createExpiredTokenHarness();
    await seedExpiredTokens(harness);

    const [files, identity] = await Promise.all([
      provider.listFiles(harness.ctx, 'me', 'f-alpha'),
      msGraphAuth.getIdentity(harness.ctx),
    ]);

    expect(harness.refreshBodies).toHaveLength(1);
    expect(files.items.map((f) => f.id)).toEqual(['file-1']);
    expect(identity?.id).toBe('user-1');
  });

  it('persists the refresh token the winning POST returned, never a retired one', async () => {
    const provider = new MsGraphProvider();
    const harness = createExpiredTokenHarness();
    await seedExpiredTokens(harness);

    await Promise.all([
      provider.listProjects(harness.ctx),
      provider.listContainers(harness.ctx, 'me'),
      provider.listFiles(harness.ctx, 'me', 'f-alpha'),
    ]);

    expect(harness.refreshBodies).toHaveLength(1);
    const stored = JSON.parse((await harness.ctx.storage.get('msgraph:tokens')) ?? '{}') as {
      refreshToken?: string;
      accessToken?: string;
    };
    expect(stored.refreshToken).toBe('refresh-token-v2');
    expect(stored.accessToken).toBe(MOCK_ACCESS_TOKEN);
  });
});
