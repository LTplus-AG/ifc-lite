/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wire types for the buildingSMART OpenCDE Documents API 1.0
 * (https://github.com/buildingSMART/documents-API/blob/release_1_0/swagger.yaml).
 * Field names are snake_case exactly as they appear on the wire.
 */
export type { FetchLike } from '@ifc-lite/opencde-foundation';

/** `CallbackLink`: where the CDE redirects the browser once a UI flow completes. */
export interface CallbackLink {
  url: string;
  /** Expiry period for the URL, in seconds. */
  expires_in: number;
}

/** `LinkData`: a single server-provided URL to call next. */
export interface LinkData {
  url: string;
}

// -- Download / selection flow -----------------------------------------------

/** Body of `POST /select-documents`. */
export interface SelectDocumentsRequest {
  callback: CallbackLink;
  server_context?: string | null;
  /** Extensions (with the dot) the CDE UI should filter the selection to, e.g. `['.ifc', '.ifczip']`. */
  supported_file_extensions?: string[];
}

/** Response of `POST /select-documents`. */
export interface DocumentDiscoverySessionInitialization {
  /** CDE UI URL for the client to open in a local browser. */
  select_documents_url: string;
  /** `select_documents_url` expiry, in seconds. */
  expires_in: number;
}

export interface FileDescription {
  name: string;
  size_in_bytes: number;
}

/** Links on a `DocumentVersion` for retrieving related data (§ DocumentVersionLinks). */
export interface DocumentVersionLinks {
  /** Self-URL for this document version. */
  document_version: LinkData;
  document_version_metadata: LinkData;
  document_version_download: LinkData;
  document_versions: LinkData;
  /** Browser URL to view/edit the document's details on the CDE; not always present. */
  document_details?: LinkData;
}

/** A single version of a document, as returned across most Documents API endpoints. */
export interface DocumentVersion {
  links: DocumentVersionLinks;
  version_number: string;
  version_index: number;
  creation_date: string;
  title: string;
  file_description: FileDescription;
  document_id: string;
}

/** Response of `GET {selected_documents_url}` after the user finishes selecting documents. */
export interface SelectedDocuments {
  /** CDE-controlled context (project/folder) to resume the UI at next time. */
  server_context?: string | null;
  documents: DocumentVersion[];
}

/** Response of `GET {document_version_metadata}`. */
export interface DocumentMetadataEntry {
  name: string;
  value: string[];
  data_type:
    | 'string'
    | 'boolean'
    | 'date-time'
    | 'date'
    | 'integer32'
    | 'integer64'
    | 'number'
    | 'url';
}

export interface DocumentMetadata {
  metadata: DocumentMetadataEntry[];
}

/** Response of `GET {document_versions}`. */
export interface DocumentVersions {
  documents: DocumentVersion[];
}

// -- Query (polling) flow -----------------------------------------------------

/** Body of `POST /document-versions`. */
export interface DocumentQuery {
  document_ids: string[];
}

/** Response of `POST /document-versions`: the latest version of each queried document. */
export interface DocumentQueryResult {
  versions: DocumentVersion[];
}

// -- Upload flow ---------------------------------------------------------------

/** Entry of `UploadDocumentsRequest.files`. */
export interface FileToUpload {
  file_name: string;
  session_file_id: string;
  /** Present when this upload is a new version of an existing document. */
  document_id?: string;
}

/** Body of `POST /upload-documents`. */
export interface UploadDocumentsRequest {
  callback: CallbackLink;
  server_context?: string | null;
  files: FileToUpload[];
}

/** Response of `POST /upload-documents`. */
export interface DocumentUploadSessionInitialization {
  /** CDE UI URL for the client to open in a local browser. */
  upload_ui_url: string;
  /** `upload_ui_url` expiry, in seconds. */
  expires_in: number;
  /** The maximum file size the CDE supports; a larger upload will be rejected. */
  max_size_in_bytes: number;
}

/** Entry of `UploadFileDetailsRequest.files`, sized so the server can plan the multipart split. */
export interface UploadFileDetail {
  size_in_bytes: number;
  /** Client-provided id matching a `FileToUpload.session_file_id`. */
  session_file_id: string;
}

/** Body of `POST {upload_documents_url}`. */
export interface UploadFileDetailsRequest {
  files: UploadFileDetail[];
}

export interface HeaderValue {
  name: string;
  value: string;
}

export interface Headers {
  values: HeaderValue[];
}

/** `MultipartFormData`: server-provided bytes to wrap each part's content with. */
export interface MultipartFormData {
  /** Base64-encoded bytes to prefix the part's binary content with. */
  prefix: string;
  /** Base64-encoded bytes to suffix the part's binary content with (typically the closing boundary). */
  suffix: string;
}

/** One request the client must make to upload a byte range of a file. */
export interface UploadFilePartInstruction {
  url: string;
  http_method: 'POST' | 'PUT';
  additional_headers?: Headers;
  /** Some storage providers reject the request if this is sent; default false. */
  include_authorization?: boolean;
  multipart_form_data?: MultipartFormData;
  /** Inclusive, zero-based start byte of this part. */
  content_range_start: number;
  /** Inclusive, zero-based end byte of this part. */
  content_range_end: number;
}

/** The full upload plan for one file: its parts, and how to complete or cancel it. */
export interface DocumentToUpload {
  session_file_id: string;
  upload_file_parts: UploadFilePartInstruction[];
  upload_completion: LinkData;
  upload_cancellation: LinkData;
}

/** Response of `POST {upload_documents_url}`. */
export interface DocumentsToUpload {
  server_context?: string | null;
  documents_to_upload: DocumentToUpload[];
}
