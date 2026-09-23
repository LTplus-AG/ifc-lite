/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF's OAuth2 token exchange and dynamic client registration are the
 * Foundation API's own (https://github.com/buildingSMART/foundation-API
 * §2.2): nothing about a password grant, a refresh, an authorization-code
 * exchange or registering a client is BCF-specific, so this module is a
 * thin re-export of `@ifc-lite/opencde-foundation`'s implementation under
 * BCF's historical names, not a second copy of it.
 */
export {
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient as registerBcfClient,
  requestClientCredentialsToken,
  requestPasswordToken,
} from '@ifc-lite/opencde-foundation';
export type {
  AuthorizationCodeGrantOptions,
  ClientCredentialsGrantOptions,
  PasswordGrantOptions,
  RefreshGrantOptions,
  RegisterClientOptions,
  RegisteredClient,
} from '@ifc-lite/opencde-foundation';
