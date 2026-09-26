/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ErrorResponse } from './types.js';

/**
 * A non-2xx answer from the server.
 *
 * Every error the server writes is the `{ error, code }` envelope
 * ({@link ErrorResponse}); `code` is its stable identifier (`NOT_FOUND`,
 * `BAD_REQUEST`, `UNAUTHORIZED`, `OVERLOADED`, ...) and is what to branch on.
 * A body that is not the envelope (a proxy in front of the server answered,
 * or a server older than the envelope's coverage of every status) still
 * yields this error, with `code` set to `HTTP_<status>`.
 *
 * @example
 * ```typescript
 * try {
 *   await client.getCached(key);
 * } catch (error) {
 *   if (error instanceof IfcServerError && error.code === 'OVERLOADED') {
 *     // retry later
 *   }
 * }
 * ```
 */
export class IfcServerError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** The envelope's `code`, or `HTTP_<status>` when the body was not the envelope. */
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'IfcServerError';
    this.status = status;
    this.code = code;
  }
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { error, code } = value as Record<string, unknown>;
  return typeof error === 'string' && typeof code === 'string';
}

/** The envelope in `text`, or `undefined` when it is not one. */
function parseErrorResponse(text: string): ErrorResponse | undefined {
  const trimmed = text.trim();
  // Empty, plain text or HTML (a proxy's error page): not the envelope, and
  // the caller falls back to the HTTP status.
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (parseError) {
    // Malformed JSON: the same status fallback is the handling, kept visible
    // at debug level rather than dropped.
    console.debug(
      '[client] Malformed JSON error body:',
      parseError instanceof Error ? parseError.message : parseError
    );
    return undefined;
  }
  return isErrorResponse(parsed) ? parsed : undefined;
}

/** Decode a failed response into an {@link IfcServerError}. Consumes the body. */
export async function serverErrorFromResponse(response: Response): Promise<IfcServerError> {
  let text = '';
  try {
    text = await response.text();
  } catch (readError) {
    // The body could not be read (the connection dropped after the status
    // arrived); the status alone still describes the failure.
    console.debug('[client] Unreadable error body:', readError);
  }
  const envelope = parseErrorResponse(text);
  if (envelope) {
    return new IfcServerError(
      `Server error (${envelope.code}): ${envelope.error}`,
      response.status,
      envelope.code
    );
  }
  return new IfcServerError(
    `Server error: ${response.status} ${response.statusText}`,
    response.status,
    `HTTP_${response.status}`
  );
}
