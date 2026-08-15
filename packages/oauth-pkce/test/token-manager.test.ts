/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../src/token-manager.js';
import { NotSignedInError } from '../src/errors.js';
import type { TokenStorage } from '../src/types.js';

function createMemoryStorage(): TokenStorage {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TokenManager.getValidAccessToken', () => {
  it('returns the stored access token without a network call when it is not near expiry', async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn();
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'still-fresh', refreshToken: 'r1', expiresAt: 1_000_000 + 10 * 60_000 });

    const token = await manager.getValidAccessToken();

    expect(token).toBe('still-fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes when the stored token is within the skew window of expiry', async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'refreshed', refresh_token: 'r2', expires_in: 3600 }));
    let now = 1_000_000;
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    // Expires in 30s — inside the 60s skew window, so this must trigger a refresh.
    await manager.setTokens({ accessToken: 'about-to-expire', refreshToken: 'r1', expiresAt: now + 30_000 });

    const token = await manager.getValidAccessToken();

    expect(token).toBe('refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await manager.getTokens();
    expect(stored?.accessToken).toBe('refreshed');
    expect(stored?.refreshToken).toBe('r2');
  });

  it('preserves the old refresh token when the refresh response omits a new one', async () => {
    const storage = createMemoryStorage();
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'refreshed', expires_in: 3600 }));
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 0,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'r1', expiresAt: -1 });

    await manager.getValidAccessToken();

    const stored = await manager.getTokens();
    expect(stored?.refreshToken).toBe('r1');
  });

  it('throws NotSignedInError when nothing is stored', async () => {
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage: createMemoryStorage(),
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(manager.getValidAccessToken()).rejects.toThrow(NotSignedInError);
  });

  it('throws NotSignedInError when the token is expired and there is no refresh token', async () => {
    const storage = createMemoryStorage();
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'expired', expiresAt: 0 });

    await expect(manager.getValidAccessToken()).rejects.toThrow(NotSignedInError);
  });

  it('collapses two concurrent refreshes triggered by an expired token into a single token-endpoint request', async () => {
    const storage = createMemoryStorage();
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'the-refresh-token', expiresAt: 0 });

    // Two callers race on the same expired token, as would happen when a page
    // fires several API calls at once.
    const first = manager.getValidAccessToken();
    const second = manager.getValidAccessToken();

    // Let both calls reach the refresh step before the token endpoint responds.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    resolveFetch(jsonResponse({ access_token: 'refreshed-once', refresh_token: 'new-refresh', expires_in: 3600 }));

    const [firstToken, secondToken] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstToken).toBe('refreshed-once');
    expect(secondToken).toBe('refreshed-once');
  });

  it('does not reuse a settled refresh for a later, separate expiry (dedup is in-flight-only, not a cache)', async () => {
    const storage = createMemoryStorage();
    let now = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'first-refresh', refresh_token: 'r2', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'second-refresh', refresh_token: 'r3', expires_in: 3600 }));
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'r1', expiresAt: now - 1 });

    const token1 = await manager.getValidAccessToken();
    now += 3600 * 1000 + 1; // advance past the first refresh's own expiry
    const token2 = await manager.getValidAccessToken();

    expect(token1).toBe('first-refresh');
    expect(token2).toBe('second-refresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a refresh that was already in flight resurrect the session after clear()', async () => {
    const storage = createMemoryStorage();
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'the-refresh-token', expiresAt: 0 });

    // A refresh is triggered (e.g. by a background call) and is still
    // in flight when the user signs out.
    const pending = manager.getValidAccessToken();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await manager.clear();

    // The token endpoint now answers the refresh that started before sign-out.
    resolveFetch(jsonResponse({ access_token: 'resurrected', refresh_token: 'new-refresh', expires_in: 3600 }));
    await expect(pending).rejects.toThrow(NotSignedInError);

    // Storage must still read as signed-out — the in-flight refresh's result
    // must not have been persisted after clear() ran.
    const stored = await manager.getTokens();
    expect(stored).toBeUndefined();
  });

  it('does not hand a stale pre-clear() refresh to a caller under a brand-new session', async () => {
    // Reviewer-confirmed defect: clear() bumps `generation` but never resets
    // `pendingRefresh`, so refresh()'s dedup check (`if (this.pendingRefresh)
    // return this.pendingRefresh;`) is generation-blind. A refresh started
    // under the old session is handed straight to a caller signed in under a
    // brand-new one.
    const storage = createMemoryStorage();
    // Each fetch call gets its own resolver — A's and B's requests must be
    // separately resolvable, since the whole point of this test is that B
    // issues its own request rather than being handed A's.
    const resolvers: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'stale-refresh-token', expiresAt: 0 });

    // A starts a refresh; it's still in flight when the user signs out.
    const pendingA = manager.getValidAccessToken();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await manager.clear();

    // A brand-new sign-in follows, with a token already inside the skew
    // window so B's own call has to go through refresh() again.
    await manager.setTokens({ accessToken: 'new-session-token', refreshToken: 'new-refresh', expiresAt: 999_999 });

    // B calls under the new session, needing its own refresh.
    const pendingB = manager.getValidAccessToken();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The token endpoint answers A's stale request first, then B's.
    resolvers[0](jsonResponse({ access_token: 'stale-result', refresh_token: 'stale-new-refresh', expires_in: 3600 }));
    resolvers[1](jsonResponse({ access_token: 'fresh-result', refresh_token: 'fresh-new-refresh', expires_in: 3600 }));

    await expect(pendingA).rejects.toThrow(NotSignedInError);
    // B has a valid, freshly-signed-in session and must not be rejected by
    // A's stale, doomed promise.
    await expect(pendingB).resolves.toBe('fresh-result');
  });
});

describe('TokenManager storage-write TOCTOU (async backends whose set()/delete() can complete out of invocation order)', () => {
  /** Models a `TokenStorage` where `set()` and `delete()` are independent
   *  async operations with no ordering guarantee relative to each other —
   *  e.g. IndexedDB, a browser-extension storage API, or a network-backed
   *  store. `set()` is gated on an externally-resolved promise so a test can
   *  let a `delete()` "land" first even though `set()` was invoked first. */
  function createGatedStorage(): TokenStorage & { armGate: () => void; releaseGate: () => void } {
    const map = new Map<string, string>();
    // `gate` is `null` (writes go through immediately) until `armGate()` is
    // called, so the test's own seeding `setTokens()` call isn't blocked —
    // only the write under test is.
    let gate: Promise<void> | null = null;
    let release: () => void = () => {};
    return {
      async get(key) {
        return map.get(key);
      },
      async set(key, value) {
        if (gate) await gate;
        map.set(key, value);
      },
      async delete(key) {
        map.delete(key);
      },
      armGate() {
        gate = new Promise((resolve) => {
          release = resolve;
        });
      },
      releaseGate: () => release(),
    };
  }

  it('does not let a stale refresh write resurrect the session when clear()"s delete lands first', async () => {
    // Reviewer-confirmed defect (narrower, storage-backend-dependent): the
    // generation check at token-manager.ts:143 reads an in-memory counter
    // and passes, but the storage write it gates is a *separate* awaited
    // step. On a backend where writes/deletes aren't ordered by invocation
    // time, clear()'s delete() can complete before the in-flight refresh's
    // set() does, and the session is resurrected at the storage layer even
    // though clear() "won" logically and `generation` is already bumped.
    const storage = createGatedStorage();
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const manager = new TokenManager({
      storageKey: 'acct-1',
      storage,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await manager.setTokens({ accessToken: 'expired', refreshToken: 'the-refresh-token', expiresAt: 0 });
    storage.armGate();

    const pending = manager.getValidAccessToken();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The refresh response arrives; refresh()'s generation check passes
    // (clear() hasn't run yet) and it starts (but does not finish) the
    // gated storage write.
    resolveFetch(jsonResponse({ access_token: 'resurrected', refresh_token: 'new-refresh', expires_in: 3600 }));
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // clear() now runs while that write is still in flight. Its delete()
    // resolves immediately — landing before the gated set() does.
    await manager.clear();

    // Only now does the stale write actually complete.
    storage.releaseGate();
    await pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    // Storage must read as signed-out. If the stale write landed after
    // clear()'s delete, this reads the resurrected token set instead.
    const stored = await manager.getTokens();
    expect(stored).toBeUndefined();
  });
});
