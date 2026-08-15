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
// `pendingRefresh` promise turns "N racing refreshes" into "one refresh, N
// callers awaiting its result" — see `getValidAccessToken` below.
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

export class TokenManager {
  private pendingRefresh: Promise<TokenSet> | null = null;
  /** Bumped by `clear()`. A refresh started before sign-out captures the
   *  generation it was launched under; if that no longer matches by the
   *  time the token endpoint responds, `clear()` ran in the meantime and
   *  the refreshed token set must not be persisted — writing it would
   *  resurrect a session the user just signed out of. */
  private generation = 0;

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
    this.generation += 1;
    await this.config.storage.delete(this.config.storageKey);
  }

  /**
   * Returns a currently-valid access token, refreshing first if the stored
   * one is expired or within `refreshSkewMs` of expiring.
   *
   * Concurrent calls collapse onto one refresh request: the first caller to
   * observe an expired token starts the refresh and records the in-flight
   * promise on `this.pendingRefresh`; every other caller that reaches the
   * refresh step before it settles returns that same promise instead of
   * issuing its own request. The refresh's async work only actually begins
   * once this synchronous bookkeeping (checking/setting `pendingRefresh`) has
   * run, so two calls issued back-to-back from the same tick — e.g. via
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
    if (this.pendingRefresh) return this.pendingRefresh;

    if (!current.refreshToken) {
      return Promise.reject(
        new NotSignedInError('access token expired and no refresh token is available; interactive sign-in is required'),
      );
    }
    const refreshToken = current.refreshToken;
    const generation = this.generation;

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
      if (generation !== this.generation) {
        // clear() ran while this refresh was in flight. Persisting `merged`
        // now would write a live token set back under the storage key the
        // user just signed out of, resurrecting the session.
        throw new NotSignedInError('signed out while the token refresh was in flight');
      }
      await this.setTokens(merged);
      return merged;
    };

    this.pendingRefresh = run().finally(() => {
      this.pendingRefresh = null;
    });
    return this.pendingRefresh;
  }
}
