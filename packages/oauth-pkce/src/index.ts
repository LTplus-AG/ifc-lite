/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `base64UrlEncode` is deliberately *not* exported: it is an internal helper
// backing the PKCE primitives below, not part of any OAuth contract this
// package offers, and anything on this file becomes a compatibility promise
// the package has to keep. Callers who want base64url for its own sake have
// `Buffer.toString('base64url')` in Node and a two-line encoder in a browser.
export { createPkcePair, deriveCodeChallengeS256, generateCodeVerifier, generateState } from './pkce.js';

export { createAuthorizationRequest, parseAuthorizationCallback } from './authorization.js';
export type { ParseAuthorizationCallbackOptions } from './authorization.js';

export { exchangeAuthorizationCode, refreshAccessToken } from './token-exchange.js';
export type { ExchangeAuthorizationCodeParams, RefreshAccessTokenParams } from './token-exchange.js';

export { TokenManager } from './token-manager.js';
export type { TokenManagerConfig } from './token-manager.js';

export {
  NotSignedInError,
  OAuthAuthorizationError,
  OAuthError,
  OAuthRedirectOriginError,
  OAuthStateMismatchError,
  TokenExchangeError,
} from './errors.js';

export type {
  AuthorizationCallbackResult,
  AuthorizationRequest,
  AuthorizationRequestConfig,
  PkceCodeChallenge,
  TokenSet,
  TokenStorage,
} from './types.js';
