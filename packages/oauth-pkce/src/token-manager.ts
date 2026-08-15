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
 * Splitting the question across two fields is what caused the last two
 * defects: `clear()` bumped `generation` but forgot to also clear
 * `pendingRefresh`, so a stale in-flight refresh could still be handed to a
 * brand-new caller by the dedup check, which never consulted `generation` at
 * all. Adding a third field alongside the first two — which is what the
 * obvious next patch would have done — would only have produced a third
 * place for a future fix to forget.
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
 */
class Session {
  pendingRefresh: Promise<TokenSet> | null = null;
}

export class TokenManager {
  private session = new Session();

  constructor(private readonly config: TokenManagerConfig) {}

  /** Persists a freshly obtained token set (from `exchangeAuthorizationCode`,
   *  typically). Overwrites whatever was stored under this key. */
  async setTokens(tokens: TokenSet): Promise<void> {
    await this.config.storage.set(this.config.storageKey, JSON.stringify(tokens));
  }

  /** Reads the stored token set as-is, with no expiry check and no refresh.
   *  Returns `undefined` if nothing is stored, or if what's stored isn't
   *  valid JSON (a foreign value under this key, or storage corruption) —
   *  treated as "signed out" rather than thrown, since the caller's own
   *  `restore()` is expected to handle "no session" silently per the plugin
   *  contract's `SourceAuth.restore` doc (no popups, no navigation). */
  async getTokens(): Promise<TokenSet | undefined> {
    const raw = await this.config.storage.get(this.config.storageKey);
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
    // `this` points to any more.
    this.session = new Session();
    await this.config.storage.delete(this.config.storageKey);
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

      if (session !== this.session) {
        // clear() ran while the token-endpoint request was in flight.
        // Persisting `merged` now would write a live token set back under
        // the storage key the user just signed out of, resurrecting the
        // session — skip the write entirely.
        throw new NotSignedInError('signed out while the token refresh was in flight');
      }

      await this.config.storage.set(this.config.storageKey, mergedJson);

      // The write above is itself an awaited step, separate from the check
      // just before it — for a `TokenStorage` whose `set`/`delete` can
      // complete out of invocation order (IndexedDB, extension storage, a
      // network-backed store), a `clear()` that starts *after* the check
      // above already passed can still have its `delete()` reach the
      // backend before this `set()` does, resurrecting the session at the
      // storage layer even though `this.session` had already moved on.
      // A check-then-write pair can't be made atomic against such a backend
      // by ordering alone — so re-validate after the write instead, and if
      // a `clear()` did land in the interim, undo it. The undo reads the
      // current value back and only deletes if it still holds exactly what
      // this call just wrote, rather than deleting unconditionally: between
      // this write settling and the check below running, a *legitimate*
      // new sign-in may already have written its own tokens over ours (see
      // the "new sign-in after clear()" case this module's tests cover) —
      // deleting unconditionally would destroy that instead of the stale
      // write it's meant to undo.
      if (session !== this.session) {
        const stillOurs = await this.config.storage.get(this.config.storageKey);
        if (stillOurs === mergedJson) {
          await this.config.storage.delete(this.config.storageKey);
        }
        throw new NotSignedInError('signed out while the token refresh was in flight');
      }

      return merged;
    };

    session.pendingRefresh = run().finally(() => {
      session.pendingRefresh = null;
    });
    return session.pendingRefresh;
  }
}
