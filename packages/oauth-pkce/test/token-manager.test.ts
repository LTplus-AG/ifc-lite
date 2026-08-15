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
});
