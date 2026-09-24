/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/opencde-foundation — client for the buildingSMART OpenCDE
 * Foundation API (https://github.com/buildingSMART/foundation-API): the
 * services and conventions every OpenCDE API (BCF, Documents, ...) shares —
 * `/foundation/versions` discovery, OAuth2 `/auth` discovery and token
 * flows, and `/current-user`. `@ifc-lite/bcf-api` and
 * `@ifc-lite/documents-api` both build their clients on top of this package.
 */

export {
  FoundationApiClient,
  normalizeApiBaseUrl,
  type FoundationApiClientOptions,
  type FoundationRequestOptions,
} from './client.js';

export {
  FoundationHttpClient,
  fetchAndValidate,
  fetchJson,
  resolveFetch,
  type FoundationHttpClientOptions,
  type HttpRequestOptions,
} from './http-client.js';

export {
  apiBaseUrlFor,
  findApiVersion,
  getFoundationVersions,
  resolveApiBaseUrl,
  type FoundationVersionsOptions,
} from './discovery.js';

export {
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
  requestClientCredentialsToken,
  requestPasswordToken,
} from './auth.js';
export type {
  AuthorizationCodeGrantOptions,
  ClientCredentialsGrantOptions,
  PasswordGrantOptions,
  RefreshGrantOptions,
  RegisterClientOptions,
  RegisteredClient,
} from './auth.js';

export { FoundationApiError, FoundationAuthenticationError, extractErrorDetail } from './errors.js';

export type {
  FetchLike,
  FoundationAuthInfo,
  FoundationCurrentUser,
  FoundationTokenProvider,
  FoundationTokenResponse,
  ApiVersion,
  FoundationVersion,
} from './types.js';
