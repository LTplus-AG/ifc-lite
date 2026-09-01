/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/bcf-api — REST client for buildingSMART BCF API (OpenCDE)
 * servers. Connects to a BCF server, authenticates via OAuth2, and pulls
 * projects, topics, comments and viewpoints into the `@ifc-lite/bcf`
 * in-memory model.
 */

export { BcfApiClient, normalizeBcfBaseUrl } from './client.js';
export type { BcfApiClientOptions, TopicQueryOptions } from './client.js';

export {
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerBcfClient,
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

export { BcfApiError, BcfAuthenticationError } from './errors.js';

export { fetchProjectAsBCF } from './sync.js';
export type { BcfProjectFetchResult, BcfSyncProgress, FetchProjectOptions } from './sync.js';

export type {
  BcfApiVersion,
  BcfAuthInfo,
  BcfClippingPlaneDto,
  BcfColoringDto,
  BcfColoringResponse,
  BcfCommentDto,
  BcfCommentWriteDto,
  BcfComponentDto,
  BcfComponentsDto,
  BcfCurrentUser,
  BcfExtensionsDto,
  BcfLineDto,
  BcfOrthogonalCameraDto,
  BcfPerspectiveCameraDto,
  BcfPointDto,
  BcfProjectDto,
  BcfSelectionResponse,
  BcfTokenProvider,
  BcfTokenResponse,
  BcfTopicDto,
  BcfTopicWriteDto,
  BcfViewpointDto,
  BcfViewSetupHintsDto,
  BcfVisibilityDto,
  BcfVisibilityResponse,
  FetchLike,
} from './types.js';
