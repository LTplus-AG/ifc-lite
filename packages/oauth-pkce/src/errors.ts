/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base class for every error this package throws. Messages here are held to
 * the same bar as the rest of this module: never interpolate a token, an
 * authorization code, a PKCE verifier, or a raw provider response body — see
 * the per-throw comments in `token-exchange.ts` and `authorization.ts` for
 * why each specific message is safe.
 */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** The `state` returned on the redirect didn't match the one this session
 *  generated — either a forged/replayed callback, or a stale tab. Per RFC
 *  6749 §10.12, `state` exists specifically to bind the callback to the
 *  request that started it and stop cross-site request forgery. */
export class OAuthStateMismatchError extends OAuthError {
  constructor() {
    super('authorization callback "state" does not match the request that started it (possible CSRF or a stale tab)');
    this.name = 'OAuthStateMismatchError';
  }
}

/** The redirect landed with an origin other than the one this flow expects. */
export class OAuthRedirectOriginError extends OAuthError {
  constructor(expectedOrigin: string) {
    super(`authorization callback origin does not match the expected redirect origin (${expectedOrigin})`);
    this.name = 'OAuthRedirectOriginError';
  }
}

/** The authorization server sent back an `error` parameter instead of a code. */
export class OAuthAuthorizationError extends OAuthError {
  constructor(readonly errorCode: string, description?: string) {
    super(`authorization server returned "${errorCode}"${description ? `: ${description}` : ''}`);
    this.name = 'OAuthAuthorizationError';
  }
}

/** The token endpoint rejected a code/refresh-token exchange, or its response
 *  didn't have the shape a token response must have. */
export class TokenExchangeError extends OAuthError {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

/** `getValidAccessToken` was called with no stored session, or with a stored
 *  session whose access token expired and which has no refresh token. */
export class NotSignedInError extends OAuthError {
  constructor(message = 'not signed in') {
    super(message);
    this.name = 'NotSignedInError';
  }
}
