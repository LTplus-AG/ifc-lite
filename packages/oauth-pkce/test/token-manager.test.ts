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

/** Drains pending microtasks. `TokenManager` now routes every storage
 *  access through its internal serialization queue (see `token-manager.ts`),
 *  which adds extra promise-chain hops beyond a bare `await storage.get()` —
 *  a fixed handful of `await Promise.resolve()` calls that was enough to
 *  reach a specific await point before is no longer a reliable tick count.
 *  Looping considerably past what's needed is harmless (there are no timers
 *  or real I/O involved, just promise microtasks) and keeps these tests from
 *  being coupled to the exact number of internal `await`s the queue adds. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
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
    await flush();

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
    await flush();

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
    await flush();

    await manager.clear();

    // A brand-new sign-in follows, with a token already inside the skew
    // window so B's own call has to go through refresh() again.
    await manager.setTokens({ accessToken: 'new-session-token', refreshToken: 'new-refresh', expiresAt: 999_999 });

    // B calls under the new session, needing its own refresh.
    const pendingB = manager.getValidAccessToken();
    await flush();

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

  it('clear() strictly waits for an in-flight refresh write instead of racing it, even against a slow backend', async () => {
    // Historical context: the design this replaced kept a generation
    // counter and re-checked it before persisting, but the storage write it
    // gated was a *separate* awaited step from the check. On a backend
    // where writes/deletes aren't ordered by invocation time, clear()'s
    // delete() could complete before the in-flight refresh's set() did,
    // resurrecting the session at the storage layer even though clear()
    // had "won" logically.
    //
    // `TokenManager` now serializes every storage operation it performs
    // through its own queue (see `token-manager.ts`), regardless of what
    // ordering guarantees the backend itself offers — so that specific
    // interleaving (an independently-issued delete() outrunning an
    // independently-issued set()) can no longer happen: there are no two
    // independent calls to race, only one queue. The trade-off this buys is
    // exactly what this test checks: `clear()` now *waits* for the gated
    // write ahead of it rather than resolving early, and only then deletes
    // — so the end state is deterministically signed-out no matter how slow
    // that write is.
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
    await flush();

    // The refresh response arrives; refresh()'s session check passes
    // (clear() hasn't run yet) and it starts (but does not finish) the
    // gated storage write — the write is now queued and holding the queue.
    resolveFetch(jsonResponse({ access_token: 'resurrected', refresh_token: 'new-refresh', expires_in: 3600 }));
    await flush();

    // clear() is called while that write is still gated. It must not
    // resolve until the write ahead of it in the queue does.
    let clearResolved = false;
    const clearPromise = manager.clear().then(() => {
      clearResolved = true;
    });
    await flush();
    expect(clearResolved).toBe(false);

    // Only now does the gated write actually complete — clear()'s delete()
    // is queued behind it and can only run afterwards.
    storage.releaseGate();
    await clearPromise;
    expect(clearResolved).toBe(true);
    await pending.catch(() => {});
    await flush();

    // Storage must read as signed-out: the delete always runs after the
    // write it was ordered behind, never before it.
    const stored = await manager.getTokens();
    expect(stored).toBeUndefined();
  });
});

describe('TokenManager: the check-then-rollback pair was itself a TOCTOU (reviewer-confirmed against ccaaee1c8)', () => {
  // Two defects were confirmed here against `ccaaee1c8`'s compare-then-
  // rollback (token-manager.ts:209-215 at that commit): (1) the rollback's
  // own `get()`-then-`delete()` is a second check-then-act, so a legitimate
  // new sign-in's `set()` landing in the gap between them got wiped by the
  // "unconditional" `delete()`; (2) a throwing rollback `delete()` left the
  // session resurrected in storage while `clear()` itself had already
  // resolved successfully. Both were reproduced RED against `ccaaee1c8`
  // with a gated/interleaving storage double before this redesign (a
  // `get()` double using `queueMicrotask` to land a competing `set()`
  // between its return and the caller's continuation, plus an `armWriteGate`
  // double to hold a refresh's write open while `clear()` ran), confirmed
  // GREEN once the check-then-write became a single queued unit, and RED
  // again on reverting the fix alone.
  //
  // The redesign removes the rollback code path entirely rather than
  // patching it — `refresh()`'s session check and its storage write are now
  // one task on `TokenManager`'s own serialization queue (see
  // `token-manager.ts`), so there is no `await` boundary between them for a
  // concurrent `clear()`/`setTokens()` to land in, and nothing to detect
  // and undo afterwards. That makes the original interleavings themselves
  // unreachable: the exact repro doubles above can no longer force the
  // rollback branch, because there is no rollback branch. What's left to
  // test is the invariant that superseded it — the two tests below.
  /** Like the gate in the describe block above, but also keeps an
   *  invocation log — `log` records, in real invocation order, when each
   *  storage call actually starts and finishes. That is what makes this
   *  test a real test of serialization rather than an accident of timing:
   *  a `delete()`/`set()` call that fires *while the gated `set()` is still
   *  blocked* — i.e. that doesn't serialize — shows up as `"delete:start"`
   *  appearing before `"set:end:..."` in the log, regardless of what final
   *  value ends up in storage once everything settles. The gate itself is
   *  single-use (cleared after the first call consumes it) so only the
   *  refresh's write is held open; a later call's own timing is what the
   *  log is there to catch. */
  function createGatedLoggingStorage(): TokenStorage & {
    armWriteGate: () => void;
    releaseWriteGate: () => void;
    log: string[];
  } {
    const map = new Map<string, string>();
    let writeGate: Promise<void> | null = null;
    let releaseWrite: () => void = () => {};
    const log: string[] = [];
    return {
      async get(key) {
        return map.get(key);
      },
      async set(key, value) {
        log.push(`set:start:${value}`);
        if (writeGate) {
          await writeGate;
          writeGate = null;
        }
        map.set(key, value);
        log.push(`set:end:${value}`);
      },
      async delete(key) {
        log.push('delete:start');
        map.delete(key);
        log.push('delete:end');
      },
      armWriteGate() {
        writeGate = new Promise((resolve) => {
          releaseWrite = resolve;
        });
      },
      releaseWriteGate: () => releaseWrite(),
      log,
    };
  }

  it('lets a legitimate new sign-in survive a stale refresh write, clear(), and the new sign-in all queuing behind one slow backend call — no rollback required', async () => {
    const storage = createGatedLoggingStorage();
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
    storage.log.length = 0; // drop the seed write from the log

    // A refresh starts; its eventual write is held open by the gate.
    storage.armWriteGate();
    const pending = manager.getValidAccessToken();
    await flush();
    resolveFetch(jsonResponse({ access_token: 'stale-refresh-result', refresh_token: 'stale-r2', expires_in: 3600 }));
    await flush();

    // The write's session check has already passed (clear() hasn't run
    // yet) and it is now blocked on the gate, holding the queue. clear()
    // and a fresh sign-in are both issued now — under a serialized manager
    // neither can even *invoke* its storage call until the gated write
    // settles; under an unserialized one they'd fire immediately.
    const newTokens = { accessToken: 'new-session-token', refreshToken: 'new-refresh', expiresAt: 999_999 };
    const clearPromise = manager.clear();
    const setNewPromise = manager.setTokens(newTokens);
    await flush();

    // Before the gate is released, nothing but the gated write's own
    // "set:start" should have reached the log — clear()'s delete() and the
    // new sign-in's set() must not have been invoked yet.
    expect(storage.log).toEqual(['set:start:{"accessToken":"stale-refresh-result","refreshToken":"stale-r2","expiresAt":4600000}']);

    storage.releaseWriteGate();
    await Promise.all([pending.catch(() => {}), clearPromise, setNewPromise]);
    await flush();

    // Real invocation order, not just final state: the stale write starts
    // and finishes first, only then does the delete start and finish, only
    // then does the new sign-in's write start and finish. No operation's
    // call to storage began while another was still in flight.
    expect(storage.log).toEqual([
      'set:start:{"accessToken":"stale-refresh-result","refreshToken":"stale-r2","expiresAt":4600000}',
      'set:end:{"accessToken":"stale-refresh-result","refreshToken":"stale-r2","expiresAt":4600000}',
      'delete:start',
      'delete:end',
      `set:start:${JSON.stringify(newTokens)}`,
      `set:end:${JSON.stringify(newTokens)}`,
    ]);

    // And because of that strict ordering, the legitimate new sign-in
    // survives — no compare, no rollback, nothing to accidentally wipe.
    const stored = await manager.getTokens();
    expect(stored).toEqual(newTokens);
  });

  it('propagates a clear() storage-delete failure to its caller and still leaves no resurrected session behind', async () => {
    // The rollback this replaced is gone, so the only remaining path where
    // a `delete()` failure could hide a resurrected session is clear()'s
    // own delete(). Session invalidation (`this.session = new Session()`)
    // is synchronous and unconditional — it does not depend on the storage
    // delete succeeding — so even when the physical delete fails, a
    // concurrently in-flight refresh's write, when its turn in the queue
    // comes, still sees `session !== this.session` and refuses to write.
    const map = new Map<string, string>();
    let deleteCalls = 0;
    const storage: TokenStorage = {
      async get(key) {
        return map.get(key);
      },
      async set(key, value) {
        map.set(key, value);
      },
      async delete(key) {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          throw new Error('backend delete failed');
        }
        map.delete(key);
      },
    };
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

    // A refresh is in flight when the user signs out.
    const pending = manager.getValidAccessToken();
    await flush();

    // clear()'s delete() (the first and only delete call in this test)
    // fails — the failure must reach the caller, not be swallowed.
    await expect(manager.clear()).rejects.toThrow('backend delete failed');

    // The in-flight refresh answers after clear() (and its failed delete)
    // have already run. Session invalidation happened regardless of the
    // delete's outcome, so the refresh's write must still be refused.
    resolveFetch(jsonResponse({ access_token: 'resurrected', refresh_token: 'new-refresh', expires_in: 3600 }));
    await expect(pending).rejects.toThrow(NotSignedInError);

    // Storage was never touched by the refresh (no resurrection); it still
    // holds whatever the failed delete() left behind (the pre-sign-out
    // tokens), not the stale refreshed ones.
    const stored = await manager.getTokens();
    expect(stored?.accessToken).not.toBe('resurrected');
  });
});
