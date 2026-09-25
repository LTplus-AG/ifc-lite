/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF's OAuth2 token exchange and dynamic client registration are the
 * Foundation API's own (https://github.com/buildingSMART/foundation-API
 * §2.2): nothing about a password grant, a refresh, an authorization-code
 * exchange or registering a client is BCF-specific, so this module is a
 * thin wrapper over `@ifc-lite/opencde-foundation`'s implementation under
 * BCF's historical names, not a second copy of it.
 */
import {
  exchangeAuthorizationCode as foundationExchangeAuthorizationCode,
  refreshAccessToken as foundationRefreshAccessToken,
  registerClient as foundationRegisterClient,
  requestClientCredentialsToken as foundationRequestClientCredentialsToken,
  requestPasswordToken as foundationRequestPasswordToken,
  type AuthorizationCodeGrantOptions,
  type ClientCredentialsGrantOptions,
  type FoundationTokenResponse,
  type PasswordGrantOptions,
  type RefreshGrantOptions,
  type RegisterClientOptions,
  type RegisteredClient,
} from '@ifc-lite/opencde-foundation';

// Each call names its errors `BcfApiError` / `BcfAuthenticationError`, as
// they were before the Foundation extraction (#5438 review).
const BCF = { errorNamespace: 'Bcf' } as const;

export function requestPasswordToken(options: PasswordGrantOptions): Promise<FoundationTokenResponse> {
  return foundationRequestPasswordToken({ ...BCF, ...options });
}

export function refreshAccessToken(options: RefreshGrantOptions): Promise<FoundationTokenResponse> {
  return foundationRefreshAccessToken({ ...BCF, ...options });
}

export function requestClientCredentialsToken(options: ClientCredentialsGrantOptions): Promise<FoundationTokenResponse> {
  return foundationRequestClientCredentialsToken({ ...BCF, ...options });
}

export function exchangeAuthorizationCode(options: AuthorizationCodeGrantOptions): Promise<FoundationTokenResponse> {
  return foundationExchangeAuthorizationCode({ ...BCF, ...options });
}

export function registerBcfClient(options: RegisterClientOptions): Promise<RegisteredClient> {
  return foundationRegisterClient({ ...BCF, ...options });
}

export type {
  AuthorizationCodeGrantOptions,
  ClientCredentialsGrantOptions,
  PasswordGrantOptions,
  RefreshGrantOptions,
  RegisterClientOptions,
  RegisteredClient,
} from '@ifc-lite/opencde-foundation';
