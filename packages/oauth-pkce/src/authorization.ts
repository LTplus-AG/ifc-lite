/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createPkcePair, generateState } from './pkce.js';
import { OAuthAuthorizationError, OAuthRedirectOriginError, OAuthStateMismatchError } from './errors.js';
import type { AuthorizationCallbackResult, AuthorizationRequest, AuthorizationRequestConfig } from './types.js';

// ============================================================================
// Authorization Code + PKCE, browser side: build the URL to send the user to,
// then validate and parse what comes back on the redirect.
// ============================================================================

/**
 * Builds the authorization-endpoint URL and the PKCE/CSRF material for one
 * sign-in attempt (RFC 6749 §4.1.1 + RFC 7636 §4.3). The caller is
 * responsible for:
 *  - persisting `state` and `codeVerifier` somewhere that survives the
 *    redirect round trip but is scoped to *this* attempt (`sessionStorage`
 *    or an in-memory map keyed by `state` both work; they must not leak into
 *    a different concurrent sign-in attempt, e.g. two tabs)
 *  - navigating the user (or a popup) to `url`
 *  - calling `parseAuthorizationCallback` with the redirect and the
 *    persisted `state` when the user comes back.
 */
export async function createAuthorizationRequest(
  config: AuthorizationRequestConfig,
): Promise<AuthorizationRequest> {
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = generateState();

  const url = new URL(config.authorizationEndpoint);
  // Caller-supplied `extraParams` is applied first and the protocol
  // parameters last, so a provider-specific extra can never shadow
  // `response_type`, `client_id`, `redirect_uri`, the PKCE pair, or `state`.
  for (const [key, value] of Object.entries(config.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  if (config.scope) url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return { url: url.toString(), state, codeVerifier };
}

export interface ParseAuthorizationCallbackOptions {
  /** The exact origin `redirectUri` resolves to, e.g. `"https://app.example.com"`. */
  readonly expectedRedirectOrigin: string;
  /** The `state` this same session generated via `createAuthorizationRequest`. */
  readonly expectedState: string;
}

/**
 * Validates a redirect back from the authorization server and extracts the
 * authorization code. Checks, in order:
 *
 *  1. **Origin** — the callback URL's origin must equal the registered
 *     redirect URI's origin. A page embedding this app (or a misconfigured
 *     relay) could otherwise hand a code intended for a different origin to
 *     this code path.
 *  2. **Provider error** — `error`/`error_description`, per RFC 6749 §4.1.2.1.
 *  3. **`state`** — must equal what this session generated (RFC 6749 §10.12).
 *     Checked *before* trusting `code` is even present, so a forged callback
 *     is rejected on the CSRF check rather than failing later for a more
 *     confusing reason.
 *  4. **`code`** presence.
 */
export function parseAuthorizationCallback(
  callbackUrl: string,
  options: ParseAuthorizationCallbackOptions,
): AuthorizationCallbackResult {
  const url = new URL(callbackUrl);

  if (url.origin !== options.expectedRedirectOrigin) {
    throw new OAuthRedirectOriginError(options.expectedRedirectOrigin);
  }

  const error = url.searchParams.get('error');
  if (error) {
    throw new OAuthAuthorizationError(error, url.searchParams.get('error_description') ?? undefined);
  }

  const state = url.searchParams.get('state');
  if (!state || state !== options.expectedState) {
    throw new OAuthStateMismatchError();
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw new OAuthAuthorizationError('invalid_response', 'callback is missing the "code" parameter');
  }

  return { code, state };
}
