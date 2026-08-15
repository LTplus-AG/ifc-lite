/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  base64UrlEncode,
  createPkcePair,
  deriveCodeChallengeS256,
  generateCodeVerifier,
  generateState,
} from './pkce.js';

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
