/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sign-out must survive a token refresh that is already on the wire.
 *
 * `TokenManager`'s protections are all PER-INSTANCE. `clear()` swaps
 * `this.session` and queues its delete on `this.queue`; a refresh re-checks
 * `session !== this.session` on its OWN instance before persisting. So a
 * provider that builds a fresh `TokenManager` per call has those guarantees by
 * name only: `signOut()` gets instance B, the in-flight listing refresh is on
 * instance A, and B's `clear()` is invisible to A. A deletes-then-writes race
 * follows, and the write wins because it lands last.
 *
 * The consequence is the one that matters here, and it is a privacy defect
 * rather than a correctness one: the user clicks Sign out, the UI goes to
 * signed-out, and a valid `refreshToken` is left sitting in `localStorage`
 * under `dropbox:tokens`. The next mount restores it and signs them straight
 * back into an account they explicitly disconnected — on a shared machine,
 * into someone else's Dropbox.
 *
 * NOTE ON THE SIBLING PACKAGE. `source-msgraph` guards the same shape with
 * `test/refresh-race.test.ts`, but its harm is different: Microsoft rotates
 * SPA refresh tokens on use, so a duplicate POST is answered `invalid_grant`
 * and kills the session. **Dropbox does not rotate** — its refresh response
 * carries no `refresh_token` and `TokenManager` merges
 * `refreshed.refreshToken ?? refreshToken`, so duplicate POSTs both succeed.
 * Copying msgraph's "exactly ONE POST" assertion here would therefore pin a
 * property that is merely wasteful for Dropbox while missing the real defect.
 * The POST count is asserted as a secondary property; the resurrection is the
 * primary one.
 */

import { describe, it, expect } from 'vitest';

import { DropboxProvider } from '../src/provider.js';
import { dropboxAuth } from '../src/auth.js';
import { createDropboxMockContext } from './dropbox-api-mock.js';
import type { DropboxMockWorld } from './dropbox-api-mock.js';

const WORLD: DropboxMockWorld = {
  items: [
    { id: 'id:folder-a', name: 'Alpha', path: '/Alpha', kind: 'folder' },
    {
      id: 'id:file-1',
      name: 'model.ifc',
      path: '/Alpha/model.ifc',
      kind: 'file',
      size: 12,
      content: 'MODEL-BYTES',
    },
  ],
};

const STORAGE_KEY = 'dropbox:tokens';

/**
 * Waits until the refresh is genuinely on the wire.
 *
 * A fixed number of microtask ticks does NOT work: reaching the token endpoint
 * goes through `getPreference` and a storage read, each of which is async, and
 * the count is an implementation detail of code this test is guarding. Polling
 * on the observable condition keeps the test from breaking when that path
 * gains or loses an await.
 */
async function waitForTokenPost(posts: readonly string[]): Promise<void> {
  for (let i = 0; i < 100 && posts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (posts.length === 0) {
    throw new Error('the listing never reached the token endpoint — harness is not exercising the race');
  }
}

interface Harness {
  readonly ctx: ReturnType<typeof createDropboxMockContext>;
  /** One entry per POST that actually reached the token endpoint. */
  readonly tokenPosts: string[];
  /** Lets the held-open token response complete. */
  release(): void;
}

/**
 * A mock context whose stored access token is already expired, and whose token
 * endpoint HANGS until `release()` is called — which is what makes the race
 * deterministic instead of timing-dependent.
 */
function createRefreshHarness(): Harness {
  const ctx = createDropboxMockContext(WORLD);
  const tokenPosts: string[] = [];
  let releaseFn = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  // Expire the seeded token so any API call must refresh first.
  void ctx.storage.set(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: 'expired-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: Date.now() - 1000,
    }),
  );

  const inner = ctx.fetch;
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input.toString();
    if (href.includes('/oauth2/token')) {
      tokenPosts.push(href);
      await gate;
      return new Response(
        JSON.stringify({
          access_token: 'refreshed-access-token',
          token_type: 'bearer',
          expires_in: 14_400,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return inner(input, init);
  };

  return {
    ctx: { ...ctx, fetch: fetchImpl },
    tokenPosts,
    release: () => releaseFn(),
  };
}

describe('sign-out vs an in-flight token refresh (#2635)', () => {
  it('does not let a refresh resurrect the tokens sign-out deleted', async () => {
    const h = createRefreshHarness();

    // A listing starts and stalls on the token endpoint — the exact state a
    // user is in when they give up on a spinner and click Sign out. Browsing
    // and Sign out are both enabled while `status === 'signed-in'`
    // (`SourceProviderRow.tsx`), so these genuinely overlap.
    const listing = new DropboxProvider().listProjects(h.ctx).catch(() => undefined);
    await waitForTokenPost(h.tokenPosts);

    await dropboxAuth.signOut(h.ctx);
    expect(await h.ctx.storage.get(STORAGE_KEY)).toBeUndefined();

    // Now let the refresh land. Before the fix it wrote a fresh, valid token
    // set back over the deleted key.
    h.release();
    await listing;
    await new Promise((r) => setTimeout(r, 0));

    const after = await h.ctx.storage.get(STORAGE_KEY);
    expect(
      after,
      `an in-flight refresh wrote tokens back AFTER sign-out deleted them: ${String(after)}. ` +
        'The user is silently signed back in on the next mount, with a live refresh token ' +
        'left in localStorage. Fix: one cached TokenManager per app key, so signOut() ' +
        "clear()s the same instance the refresh checks (see createTokenManager's managerCache).",
    ).toBeUndefined();
  });

  it('leaves the session signed out after the race settles', async () => {
    const h = createRefreshHarness();
    const listing = new DropboxProvider().listProjects(h.ctx).catch(() => undefined);
    await waitForTokenPost(h.tokenPosts);
    await dropboxAuth.signOut(h.ctx);
    h.release();
    await listing;
    await new Promise((r) => setTimeout(r, 0));

    // The user-visible consequence, asserted through the public contract
    // rather than through storage: a fresh mount must NOT find an identity.
    expect(
      await dropboxAuth.getIdentity(h.ctx),
      'the next mount signed the user back into the account they just disconnected',
    ).toBeNull();
  });

  it('de-duplicates overlapping refreshes onto one token-endpoint POST', async () => {
    const h = createRefreshHarness();
    const provider = new DropboxProvider();

    // Two overlapping calls while the stored token is expired. Sharing one
    // manager means one `pendingRefresh`, so one POST. Dropbox does not rotate
    // refresh tokens, so a second POST would not kill the session the way it
    // does on msgraph — this is a wasted round trip, asserted to keep the
    // de-duplication honest rather than because it is the headline defect.
    const a = provider.listProjects(h.ctx).catch(() => undefined);
    const b = provider.listProjects(h.ctx).catch(() => undefined);
    await waitForTokenPost(h.tokenPosts);
    h.release();
    await Promise.all([a, b]);

    expect(h.tokenPosts.length).toBe(1);
  });
});
