/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing the query parameters the CDE appends to the client's callback URL
 * (`SelectDocuments.callback` / `UploadDocumentsRequest.callback`) when it
 * redirects the browser back after a UI flow finishes.
 */

/** Result of the CDE redirecting back after `/select-documents`. */
export type SelectDocumentsCallbackResult =
  | { status: 'selected'; selectedDocumentsUrl: string }
  | { status: 'cancelled' };

/**
 * Parse the query string of the browser redirect the CDE sends after the
 * user finishes (or cancels) the select-documents UI. Accepts a `URL`,
 * a query string, or a `URLSearchParams` directly.
 */
export function parseSelectDocumentsCallback(
  input: URL | string | URLSearchParams,
): SelectDocumentsCallbackResult {
  const params = toSearchParams(input);
  if (params.get('user_cancelled_selection') === 'true') return { status: 'cancelled' };
  const selectedDocumentsUrl = params.get('selected_documents_url');
  if (!selectedDocumentsUrl) {
    throw new Error(
      'Callback carries neither selected_documents_url nor user_cancelled_selection=true',
    );
  }
  return { status: 'selected', selectedDocumentsUrl };
}

/** Result of the CDE redirecting back after `/upload-documents`. */
export type UploadDocumentsCallbackResult =
  | { status: 'ready'; uploadDocumentsUrl: string }
  | { status: 'cancelled' };

/**
 * Parse the query string of the browser redirect the CDE sends after the
 * user finishes (or cancels) entering upload metadata.
 */
export function parseUploadDocumentsCallback(
  input: URL | string | URLSearchParams,
): UploadDocumentsCallbackResult {
  const params = toSearchParams(input);
  if (params.get('user_cancelled_upload') === 'true') return { status: 'cancelled' };
  const uploadDocumentsUrl = params.get('upload_documents_url');
  if (!uploadDocumentsUrl) {
    throw new Error('Callback carries neither upload_documents_url nor user_cancelled_upload=true');
  }
  return { status: 'ready', uploadDocumentsUrl };
}

function toSearchParams(input: URL | string | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === 'string') {
    // Accept either a bare query string ('?a=b' or 'a=b') or a full URL.
    try {
      return new URL(input).searchParams;
    } catch {
      return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
    }
  }
  return input.searchParams;
}
