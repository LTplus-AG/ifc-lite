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

/**
 * Sign-out must survive a token refresh that is already on the wire — the
 * same shape `source-dropbox/test/refresh-race.test.ts` guards (`#2635`),
 * adapted to this package's extra trigger: the `clientId`/`tenant`
 * preference changing between the armed manager's creation and `signOut`.
 *
 * `TokenManager`'s protections are all PER-INSTANCE (see `token-manager.ts`
 * in `@ifc-lite/oauth-pkce`): `clear()` swaps `this.session` and a refresh
 * re-checks `session !== this.session` on its OWN instance before persisting.
 * `signOut` above builds its manager from freshly-read preferences — if
 * `clientId`/`tenant` haven't changed since the manager holding the in-flight
 * refresh was created, that's the same cached instance and `clear()` lands on
 * it correctly. If they *have* changed (a host config reload landing right as
 * the user clicks Sign out), `signOut` would resolve to a *different*
 * `managerCache` entry, and clearing only that one leaves the real, armed
 * manager's refresh free to write a valid token set back after this deletes
 * it — resurrecting a session the user explicitly signed out of. Fixed by
 * clearing every cached manager, not just the one preferences currently name.
 */
describe('sign-out vs an in-flight token refresh (mirrors source-dropbox #2635)', () => {
  interface ResurrectionHarness {
    readonly ctx: ReturnType<typeof createGraphMockContext>;
    /** One entry per POST that actually reached the token endpoint. */
    readonly tokenPosts: string[];
    /** Lets the held-open token response complete. */
    release(): void;
    /** Simulates the `clientId` preference changing (or being cleared) after
     *  the in-flight refresh's manager was already created. */
    clearClientIdPreference(): void;
  }

  /**
   * A context whose stored access token is already expired, and whose token
   * endpoint HANGS until `release()` is called — deterministic fault
   * injection instead of a timing-dependent race, mirroring
   * `source-dropbox/test/refresh-race.test.ts`'s `createRefreshHarness`.
   */
  function createResurrectionHarness(): ResurrectionHarness {
    const base = createGraphMockContext(WORLD);
    const tokenPosts: string[] = [];
    let releaseFn = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    let clientIdPref: string | undefined = 'mock-client-id';

    void base.storage.set(
      'msgraph:tokens',
      JSON.stringify({
        accessToken: 'expired-access-token',
        refreshToken: 'mock-refresh-token',
        expiresAt: Date.now() - 1000,
      }),
    );

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input.toString();
      if (!href.includes('/oauth2/v2.0/token')) return base.fetch(input, init);

      tokenPosts.push(href);
      await gate;
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'refresh-token-v2',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const ctx = {
      ...base,
      fetch: fetchImpl,
      getPreference: (name: string) => {
        if (name === 'clientId') return Promise.resolve(clientIdPref);
        if (name === 'tenant') return Promise.resolve('common');
        return Promise.resolve(undefined);
      },
    };

    return {
      ctx,
      tokenPosts,
      release: () => releaseFn(),
      clearClientIdPreference: () => {
        clientIdPref = undefined;
      },
    };
  }

  async function waitForTokenPost(posts: readonly string[]): Promise<void> {
    for (let i = 0; i < 100 && posts.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (posts.length === 0) {
      throw new Error('the listing never reached the token endpoint — harness is not exercising the race');
    }
  }

  it('does not let a refresh resurrect the tokens sign-out deleted, even if clientId changed first', async () => {
    const h = createResurrectionHarness();

    // A listing starts and stalls on the token endpoint — the exact state a
    // user is in when they give up on a spinner and click Sign out.
    const listing = new MsGraphProvider().listProjects(h.ctx).catch(() => undefined);
    await waitForTokenPost(h.tokenPosts);

    // The clientId preference is cleared before signOut runs — e.g. a host
    // config reload landing at the same moment. `signOut` now resolves to a
    // *different* cache key ('unconfigured|common') than the manager that
    // actually holds this in-flight refresh ('mock-client-id|common').
    h.clearClientIdPreference();

    await msGraphAuth.signOut(h.ctx);
    expect(await h.ctx.storage.get('msgraph:tokens')).toBeUndefined();

    // Now let the refresh land. Before the fix, only the 'unconfigured|common'
    // manager was cleared — the armed 'mock-client-id|common' manager's
    // refresh still saw its own (unchanged) session and wrote a fresh, valid
    // token set back over the deleted key.
    h.release();
    await listing;
    await new Promise((r) => setTimeout(r, 0));

    const after = await h.ctx.storage.get('msgraph:tokens');
    expect(
      after,
      `an in-flight refresh wrote tokens back AFTER sign-out deleted them: ${String(after)}. ` +
        'The user is silently signed back in on the next mount, with a live refresh token ' +
        'left in localStorage. Fix: signOut() must clear() every cached TokenManager, not just ' +
        "the one built from the preferences read at signOut time (see createTokenManager's managerCache).",
    ).toBeUndefined();
  });

  it('leaves the session signed out after the race settles, even if clientId changed first', async () => {
    const h = createResurrectionHarness();
    const listing = new MsGraphProvider().listProjects(h.ctx).catch(() => undefined);
    await waitForTokenPost(h.tokenPosts);
    h.clearClientIdPreference();
    await msGraphAuth.signOut(h.ctx);
    h.release();
    await listing;
    await new Promise((r) => setTimeout(r, 0));

    // The user-visible consequence, asserted through the storage state rather
    // than a single read path: the race must not leave a live token set
    // behind, regardless of which identity-read path a caller happens to use.
    expect(await h.ctx.storage.get('msgraph:tokens'), 'storage must stay clean after the race settles').toBeUndefined();
  });
});
