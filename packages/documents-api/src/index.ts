/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/documents-api — client for the buildingSMART OpenCDE Documents
 * API 1.0 (https://github.com/buildingSMART/documents-API): select and
 * download documents from a CDE's UI, poll for new versions, and upload
 * files through the multi-part upload flow. Discovery and OAuth2 auth are
 * `@ifc-lite/opencde-foundation`'s.
 */

export { DocumentsApiClient, type DocumentsApiClientOptions } from './client.js';

export {
  discoverDocumentsService,
  type DiscoverDocumentsServiceOptions,
  type DocumentsServiceDiscovery,
} from './discovery.js';

export {
  parseSelectDocumentsCallback,
  parseUploadDocumentsCallback,
  type SelectDocumentsCallbackResult,
  type UploadDocumentsCallbackResult,
} from './callback.js';

export { buildUploadPartBody, uploadFilePart, type UploadFilePartOptions } from './upload.js';

export {
  FoundationApiError as DocumentsApiError,
  FoundationAuthenticationError as DocumentsAuthenticationError,
} from '@ifc-lite/opencde-foundation';

export type {
  CallbackLink,
  DocumentDiscoverySessionInitialization,
  DocumentMetadata,
  DocumentMetadataEntry,
  DocumentQuery,
  DocumentQueryResult,
  DocumentToUpload,
  DocumentUploadSessionInitialization,
  DocumentVersion,
  DocumentVersionLinks,
  DocumentVersions,
  DocumentsToUpload,
  FetchLike,
  FileDescription,
  FileToUpload,
  Headers,
  HeaderValue,
  LinkData,
  MultipartFormData,
  SelectDocumentsRequest,
  SelectedDocuments,
  UploadDocumentsRequest,
  UploadFileDetail,
  UploadFileDetailsRequest,
  UploadFilePartInstruction,
} from './types.js';
