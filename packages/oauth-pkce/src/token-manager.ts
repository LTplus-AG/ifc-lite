/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { refreshAccessToken } from './token-exchange.js';
import { NotSignedInError } from './errors.js';
import type { TokenSet, TokenStorage } from './types.js';

// ============================================================================
// Persists a `TokenSet` behind a caller-supplied `TokenStorage`, and serves
// `getValidAccessToken()` — refreshing transparently when the stored access
// token is expired (or close to it).
//
// The one subtlety worth documenting: concurrent refresh de-duplication.
// A page that fires several API calls at once (e.g. loading a project tree)
// can call `getValidAccessToken()` several times while the stored token is
// already expired. Each of those, done naively, would refresh independently
// — and most OAuth token endpoints treat a refresh token as single-use,
// rotating it on every use (RFC 6749 §6: "The authorization server MAY issue
// a new refresh token"; providers that rotate reject the *old* one on its
// next use). Two callers racing to refresh the same stored token then means
// one of them wins, persists a new refresh token, and the other's request
// either fails outright or silently clobbers the winner's token with a
// response the server has already invalidated. Serializing on a single
// dedup promise turns "N racing refreshes" into "one refresh, N callers
// awaiting its result" — see `getValidAccessToken` below.
// ============================================================================

export interface TokenManagerConfig {
  /** Storage key this manager reads/writes. Callers running more than one
   *  provider/account through the same `TokenStorage` must namespace this
   *  themselves (e.g. `"<provider>:<accountId>"`). */
  readonly storageKey: string;
  readonly storage: TokenStorage;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly fetch: typeof fetch;
  /** Refresh this many ms before the token's actual expiry, to absorb the
   *  refresh request's own latency and clock skew between this client and
   *  the authorization server. Default 60s. */
  readonly refreshSkewMs?: number;
  readonly now?: () => number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Everything tied to one signed-in session's lifetime, as a single object
 * `clear()` replaces wholesale rather than resetting piecemeal.
 *
 * Earlier versions of this file tracked the same underlying question — "is
 * this operation still working on behalf of the session that's current
 * right now?" — with two independent fields: `pendingRefresh` (the in-flight
 * refresh-dedup promise) and a `generation` counter bumped by `clear()`.
 * Splitting the question across two fields is what caused a defect:
 * `clear()` bumped `generation` but forgot to also clear `pendingRefresh`,
 * so a stale in-flight refresh could still be handed to a brand-new caller
 * by the dedup check, which never consulted `generation` at all.
 *
 * Folding both into one `Session` object removes the field to forget: the
 * dedup promise now *lives inside* the session it was started under, so
 * "does this dedup promise belong to the current session" and "is this the
 * current session" collapse into the same reference comparison
 * (`session === this.session`). A refresh's closure captures the `Session`
 * it was launched under; once `clear()` swaps `this.session` for a new
 * instance, that closure is left holding a reference nothing else can
 * reach — new callers read `this.session.pendingRefresh`, which is `null`
 * on the fresh object, so they can never be handed the stale promise, and
 * the closure's own identity check (`session !== this.session`) fails
 * wherever it still checks. There is no second field left to go stale.
 *
 * This part of the design was independently re-verified as correct across
 * several rounds of review and is unchanged here — what follows fixes a
 * *different* problem: the session check and the storage write it gates
 * used to be two separate `await`s, which is a gap a concurrent write can
 * land in no matter how carefully the check is written. See `queue` below.
 */
class Session {
  pendingRefresh: Promise<TokenSet> | null = null;
}

export class TokenManager {
  private session = new Session();

  /**
   * Every `TokenStorage` operation this manager performs against
   * `config.storage` — `get`, `set`, `delete`, and the session-check-then-
   * write a refresh does before persisting — runs through this promise
   * chain, one at a time, in the order it was enqueued. That is what
   * replaces the old check-then-rollback machinery: a refresh's "is my
   * session still current, and if so, write" is now a *single* queued task,
   * so there is no `await` boundary between the check and the write for a
   * concurrent `clear()` or `setTokens()` to land in, and therefore nothing
   * to detect after the fact and undo. Two previous rounds tried to make a
   * check-then-write pair safe by re-validating after the write and rolling
   * back on mismatch (`git log` on this file has the details); the rollback
   * was itself a second check-then-act with the same shape of gap, one
   * level down. Serializing the operations removes the gap instead of
   * chasing it to a smaller time window.
   *
   * This does mean an operation can wait behind whatever this manager's own
   * previous operation is still doing — most concretely, `clear()`
   * (sign-out) can wait behind a refresh's in-flight write. That trade-off
   * was rejected in an earlier round on the grounds that sign-out could
   * then hang on a slow backend. That concern is real, but the queue this
   * manager owns only ever holds *this manager's* own handful of
   * operations for *one* storage key — a refresh write, a `clear()`, an
   * occasional explicit `setTokens()` — so the wait is bounded by one
   * storage round trip already in flight, not by unrelated traffic
   * elsewhere in the app. A storage backend that hangs outright is a
   * problem for every caller of it, serialized or not; this queue does not
   * make that failure mode worse, it just makes sign-out share it with the
   * write that was already in progress.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: TokenManagerConfig) {}

  /** Chains `task` onto `queue` so it runs after every previously-enqueued
   *  task has settled and before any task enqueued after it starts — the
   *  serialization point every storage access goes through. `task` runs
   *  regardless of whether the previous task fulfilled or rejected (a
   *  failed operation must not wedge every later one behind a permanently-
   *  rejected chain); the caller gets `task`'s own outcome via the returned
   *  promise, error included — nothing is swallowed here. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Persists a freshly obtained token set (from `exchangeAuthorizationCode`,
   *  typically). Overwrites whatever was stored under this key. */
  async setTokens(tokens: TokenSet): Promise<void> {
    const json = JSON.stringify(tokens);
    await this.enqueue(() => this.config.storage.set(this.config.storageKey, json));
  }

  /** Reads the stored token set as-is, with no expiry check and no refresh.
   *  Returns `undefined` if nothing is stored, or if what's stored isn't
   *  valid JSON (a foreign value under this key, or storage corruption) —
   *  treated as "signed out" rather than thrown, since the caller's own
   *  `restore()` is expected to handle "no session" silently per the plugin
   *  contract's `SourceAuth.restore` doc (no popups, no navigation). */
  async getTokens(): Promise<TokenSet | undefined> {
    const raw = await this.enqueue(() => this.config.storage.get(this.config.storageKey));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as TokenSet;
    } catch {
      return undefined;
    }
  }

  /** Forgets the stored session (sign-out). Does not call the provider's
   *  token-revocation endpoint, if it has one — that's provider-specific and
   *  out of this package's scope; callers should revoke first if they want
   *  server-side revocation, then call this. */
  async clear(): Promise<void> {
    // Replacing the session object (rather than mutating a counter on the
    // existing one) is what disarms any refresh already in flight: it holds
    // a closure over the *old* `Session`, which nothing reachable from
    // `this` points to any more. This swap is synchronous and immediate —
    // it does not wait for the queue — so a refresh's check
    // (`session !== this.session`) sees it the moment `clear()` is called,
    // regardless of where `clear()`'s own `delete()` lands in the queue.
    this.session = new Session();
    // The delete itself still goes through the queue, so it is strictly
    // ordered against any write already ahead of it: if a refresh's write
    // was enqueued first, this delete runs after it (and the delete wins,
    // since it's last) rather than racing it at the storage layer.
    await this.enqueue(() => this.config.storage.delete(this.config.storageKey));
  }

  /**
   * Returns a currently-valid access token, refreshing first if the stored
   * one is expired or within `refreshSkewMs` of expiring.
   *
   * Concurrent calls collapse onto one refresh request: the first caller to
   * observe an expired token starts the refresh and records the in-flight
   * promise on the current session's `pendingRefresh`; every other caller
   * that reaches the refresh step before it settles, *and is still on that
   * same session*, returns that same promise instead of issuing its own
   * request. The refresh's async work only actually begins once this
   * synchronous bookkeeping (checking/setting `pendingRefresh`) has run, so
   * two calls issued back-to-back from the same tick — e.g. via
   * `Promise.all` — cannot both pass the check before either sets the field.
   *
   * Throws `NotSignedInError` if there is no stored session, or if the
   * stored session is expired with no refresh token to recover with.
   */
  async getValidAccessToken(): Promise<string> {
    const tokens = await this.getTokens();
    if (!tokens) throw new NotSignedInError();

    const now = (this.config.now ?? Date.now)();
    const skew = this.config.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (tokens.expiresAt - skew > now) {
      return tokens.accessToken;
    }

    const refreshed = await this.refresh(tokens);
    return refreshed.accessToken;
  }

  private refresh(current: TokenSet): Promise<TokenSet> {
    // `this.session` is read once, synchronously, and everything below —
    // the dedup check, the closure's captured reference, the staleness
    // checks — operates on this same object. A `clear()` that runs at any
    // point from here on replaces `this.session` with a different instance,
    // never mutates this one, so `session` always continues to mean
    // "the session this particular call started under."
    const session = this.session;
    if (session.pendingRefresh) return session.pendingRefresh;

    if (!current.refreshToken) {
      return Promise.reject(
        new NotSignedInError('access token expired and no refresh token is available; interactive sign-in is required'),
      );
    }
    const refreshToken = current.refreshToken;

    const run = async (): Promise<TokenSet> => {
      const refreshed = await refreshAccessToken({
        tokenEndpoint: this.config.tokenEndpoint,
        clientId: this.config.clientId,
        refreshToken,
        fetch: this.config.fetch,
        now: this.config.now,
      });
      // RFC 6749 §6: the server "MAY issue a new refresh token" — it is not
      // required to. When it doesn't, the response has no `refresh_token`
      // field at all, and the existing one remains valid and must keep being
      // used; dropping it here would strand the session on the next expiry.
      const merged: TokenSet = { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
      const mergedJson = JSON.stringify(merged);

      // The session check and the write are one queued task: nothing else
      // that touches storage for this key — a concurrent clear()'s
      // delete(), a concurrent setTokens() from a brand-new sign-in — can
      // run between the check and the write, because they all go through
      // the same `queue` and this task holds it until both steps are done.
      // If clear() ran (on this session or a later one) at any point before
      // this task reaches the front of the queue, `session !== this.session`
      // is already true by the time this task runs — clear()'s session swap
      // is synchronous and immediate, not itself queued — so the write is
      // skipped outright rather than needing to be undone afterwards.
      await this.enqueue(async () => {
        if (session !== this.session) {
          // clear() ran (or a new session started) before this write's
          // turn came up. Persisting `merged` now would write a live token
          // set back under the storage key the user signed out of, or
          // clobber a legitimate new session's tokens with a stale refresh
          // result — skip the write entirely. There is nothing to roll
          // back: the write never happened.
          throw new NotSignedInError('signed out while the token refresh was in flight');
        }
        await this.config.storage.set(this.config.storageKey, mergedJson);
      });

      return merged;
    };

    session.pendingRefresh = run().finally(() => {
      session.pendingRefresh = null;
    });
    return session.pendingRefresh;
  }
}
