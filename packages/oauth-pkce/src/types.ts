/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Shared types for the OAuth 2.0 Authorization Code + PKCE flow.
//
// This package assumes a *public* client — a browser app with no client
// secret (RFC 6749 §2.1: "Clients incapable of maintaining the confidentiality
// of their credentials ... are typically ... implemented within a browser").
// PKCE (RFC 7636) replaces the secret: the authorization code is bound to a
// per-request verifier only this browser session ever holds.
// ============================================================================

/** A freshly derived PKCE pair, ready to drive one authorization attempt. */
export interface PkceCodeChallenge {
  /** RFC 7636 §4.1: 43-128 char high-entropy random string. Never send this
   *  to the authorization endpoint — only the derived challenge goes in the
   *  authorization URL; the verifier is redeemed later, at the token endpoint. */
  readonly codeVerifier: string;
  /** RFC 7636 §4.2, S256 method: BASE64URL(SHA256(ASCII(code_verifier))). */
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
}

/** One access/refresh token pair, as persisted between requests. */
export interface TokenSet {
  readonly accessToken: string;
  /** Absent when the provider issued a non-refreshable (or already-expired
   *  single-use) access token; callers must treat re-authentication as the
   *  only recovery path in that case. */
  readonly refreshToken?: string;
  /** Epoch milliseconds; derived from the token response's `expires_in`. */
  readonly expiresAt: number;
  readonly scope?: string;
  readonly tokenType?: string;
}

/**
 * Minimal storage contract this module needs. Deliberately a subset of
 * `@ifc-lite/plugin-api`'s `KeyValueStore` (same method names/signatures) so
 * a provider can hand its `ctx.storage` straight through without an adapter —
 * but this package does not depend on `@ifc-lite/plugin-api`, so it stays
 * usable by a host or provider that has never heard of the plugin contract.
 *
 * Where tokens end up living is a decision the *caller* makes by choosing
 * what to pass here — see the package README for the trade-off this module
 * deliberately does not resolve on the caller's behalf.
 */
export interface TokenStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Everything needed to build one authorization request. */
export interface AuthorizationRequestConfig {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  /** Must exactly match a redirect URI registered with the provider. */
  readonly redirectUri: string;
  readonly scope?: string;
  /** Provider-specific extras (e.g. `prompt`, `access_type`). Applied last,
   *  so a caller cannot use this to override `response_type`, `client_id`,
   *  `redirect_uri`, `code_challenge`, `code_challenge_method` or `state` —
   *  those are set from the fields above and from freshly generated PKCE/CSRF
   *  material, never from caller-supplied strings. */
  readonly extraParams?: Readonly<Record<string, string>>;
}

/** The result of `createAuthorizationRequest`: what to navigate to, and what
 *  the caller must hold onto (in memory or session storage, tied to this one
 *  in-flight attempt) to validate and complete the round trip. */
export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
}

/** The `code`/`state` pair recovered from a validated redirect. */
export interface AuthorizationCallbackResult {
  readonly code: string;
  readonly state: string;
}
