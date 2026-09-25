/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  FoundationApiError,
  FoundationHttpClient,
  type FoundationHttpClientOptions,
} from '@ifc-lite/opencde-foundation';
import { uploadFilePart, type UploadFilePartOptions } from './upload.js';
import type {
  DocumentDiscoverySessionInitialization,
  DocumentMetadata,
  DocumentQuery,
  DocumentQueryResult,
  DocumentUploadSessionInitialization,
  DocumentVersion,
  DocumentVersions,
  DocumentsToUpload,
  SelectDocumentsRequest,
  SelectedDocuments,
  UploadDocumentsRequest,
  UploadFileDetailsRequest,
  UploadFilePartInstruction,
} from './types.js';

export interface DocumentsApiClientOptions extends FoundationHttpClientOptions {
  /**
   * Base URL of the Documents API itself, e.g.
   * `https://example.com/documents/1.0` — already the version-qualified
   * `api_base_url` a `/foundation/versions` lookup returns (see
   * {@link discoverDocumentsService}), NOT the bare server address.
   */
  baseUrl: string;
}

/** A `queryDocumentVersions` answer, with the ETag to send next time (`null` when the server sent none). */
export interface DocumentVersionsPoll {
  readonly result: DocumentQueryResult;
  readonly etag: string | null;
}

/**
 * Client for the buildingSMART OpenCDE Documents API 1.0
 * (https://github.com/buildingSMART/documents-API). Unlike BCF, most of this
 * API is link-driven: only `/select-documents`, `/upload-documents` and
 * `/document-versions` are fixed paths under the base URL — every other
 * operation follows a `url` the server handed back in a previous response,
 * which is why most methods below take that URL as their argument rather
 * than building one.
 */
export class DocumentsApiClient extends FoundationHttpClient {
  private readonly baseUrl: string;

  constructor(options: DocumentsApiClientOptions) {
    super({ ...options, errorLabel: 'Documents' });
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  }

  // -- Selection / download flow (swagger `Download` tag) --------------------

  /** `POST /select-documents`: start the CDE's document-selection UI flow. */
  selectDocuments(
    request: SelectDocumentsRequest,
  ): Promise<DocumentDiscoverySessionInitialization> {
    return this.requestJson(`${this.baseUrl}/select-documents`, {
      method: 'POST',
      body: request,
    });
  }

  /**
   * `GET {selectedDocumentsUrl}`: the user's selection, once the CDE
   * redirects the client's callback with `?selected_documents_url=...`
   * (see `parseSelectDocumentsCallback`).
   */
  getSelectedDocuments(selectedDocumentsUrl: string): Promise<SelectedDocuments> {
    return this.requestJson(selectedDocumentsUrl);
  }

  /** `GET {document_version_metadata}` link off a `DocumentVersion`. */
  getDocumentMetadata(documentVersionMetadataUrl: string): Promise<DocumentMetadata> {
    return this.requestJson(documentVersionMetadataUrl);
  }

  /** `GET {document_versions}` link off a `DocumentVersion`: every version of that document. */
  getDocumentVersions(documentVersionsUrl: string): Promise<DocumentVersions> {
    return this.requestJson(documentVersionsUrl);
  }

  /** `GET {document_version}` link off a `DocumentVersion`: that version's own self-URL. */
  getDocumentVersion(documentVersionUrl: string): Promise<DocumentVersion> {
    return this.requestJson(documentVersionUrl);
  }

  /** `GET {document_version_download}` link off a `DocumentVersion`: the file content. */
  async downloadDocumentVersion(documentVersionDownloadUrl: string): Promise<Blob> {
    const response = await this.sendRequest(documentVersionDownloadUrl, {
      headers: { Accept: 'application/octet-stream' },
    });
    return response.blob();
  }

  // -- Query / polling flow (swagger `Query` tag) -----------------------------

  /**
   * `POST /document-versions`: the latest version of each of `documentIds`,
   * in one call — meant for periodic polling of a tracked collection.
   * `ifNoneMatch`, when given the ETag from a previous call, lets the server
   * answer 304 (returned here as `null`) when nothing changed. The response's
   * own ETag is returned with the result: it is what the NEXT call passes, so
   * dropping it made the polling flow impossible to start (#5438 review).
   */
  async queryDocumentVersions(
    documentIds: string[],
    ifNoneMatch?: string,
  ): Promise<DocumentVersionsPoll | null> {
    const url = `${this.baseUrl}/document-versions`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const token = await this.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const body: DocumentQuery = { document_ids: documentIds };
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 304) return null;
    if (!response.ok) {
      throw new FoundationApiError(`Documents request failed (HTTP ${response.status}) at ${url}`, {
        status: response.status,
        url,
      });
    }
    return { result: (await response.json()) as DocumentQueryResult, etag: response.headers.get('ETag') };
  }

  // -- Upload flow (swagger `Upload` tag) --------------------------------------

  /** `POST /upload-documents`: start the CDE's upload-metadata UI flow. */
  uploadDocuments(request: UploadDocumentsRequest): Promise<DocumentUploadSessionInitialization> {
    return this.requestJson(`${this.baseUrl}/upload-documents`, {
      method: 'POST',
      body: request,
    });
  }

  /**
   * `POST {uploadDocumentsUrl}`: once the CDE redirects the client's
   * callback with `?upload_documents_url=...` (see
   * `parseUploadDocumentsCallback`), send each file's size so the server can
   * plan the multipart split and hand back upload instructions.
   */
  getUploadInstructions(
    uploadDocumentsUrl: string,
    files: UploadFileDetailsRequest['files'],
  ): Promise<DocumentsToUpload> {
    return this.requestJson(uploadDocumentsUrl, { method: 'POST', body: { files } });
  }

  /**
   * Upload one part of a file per its `UploadFilePartInstruction`. Parts may
   * be uploaded concurrently and in any order; call this once per entry in
   * `DocumentToUpload.upload_file_parts`, then {@link completeUpload}.
   */
  uploadFilePart(instruction: UploadFilePartInstruction, fileBytes: Uint8Array): Promise<void> {
    const options: UploadFilePartOptions = { fetchFn: this.fetchFn, getAccessToken: this.getAccessToken };
    return uploadFilePart(instruction, fileBytes, options);
  }

  /** `POST {upload_completion}` link off a `DocumentToUpload`, once every part has uploaded. */
  completeUpload(uploadCompletionUrl: string): Promise<DocumentVersion> {
    return this.requestJson(uploadCompletionUrl, { method: 'POST' });
  }

  /** `POST {upload_cancellation}` link off a `DocumentToUpload`. */
  async cancelUpload(uploadCancellationUrl: string): Promise<void> {
    await this.sendRequest(uploadCancellationUrl, { method: 'POST' });
  }
}
