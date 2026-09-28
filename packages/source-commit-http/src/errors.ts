/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitSourceErrorCode } from '@ifc-lite/plugin-api';

/**
 * Upstream response bodies are interpolated into thrown messages, which reach
 * user-facing toasts unmodified — capped the same way every other provider in
 * this repo caps them.
 */
const MAX_ERROR_BODY_CHARS = 200;

function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Carries `code` so a host narrows it with `isCommitSourceError`. */
export class CommitHttpError extends Error {
  readonly code: CommitSourceErrorCode;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CommitSourceErrorCode,
    message: string,
    status: number,
    extra?: { readonly retryAfterMs?: number; readonly details?: Readonly<Record<string, unknown>> },
  ) {
    super(message);
    this.name = 'CommitHttpError';
    this.code = code;
    this.status = status;
    if (extra?.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra?.details !== undefined) this.details = extra.details;
  }
}

/**
 * HTTP status → contract code, for a service that did NOT send a JSON error
 * body. The REST contract says it should; a proxy returning its own 502 page
 * has not read the contract, and the host still has to do something sensible.
 */
function codeForStatus(status: number): CommitSourceErrorCode {
  if (status === 404) return 'not-found';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 202) return 'not-ready';
  if (status === 415) return 'unsupported-format';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}

const KNOWN_CODES: ReadonlySet<string> = new Set<CommitSourceErrorCode>([
  'not-found', 'forbidden', 'conflict', 'not-ready', 'unsupported-format', 'invalid', 'unavailable',
]);

/**
 * Builds the error for a non-2xx (or 202) response.
 *
 * The service's own `code` wins when it sends one the contract knows, because
 * only the service can distinguish `invalid` from `unsupported-format` on a
 * 400. An unrecognised code falls back to the status mapping rather than
 * being passed through: a host that branched on a code outside the union
 * would have no branch to take.
 */
export function errorFromResponse(status: number, body: unknown, rawBody: string): CommitHttpError {
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    code?: unknown;
    message?: unknown;
    retryAfterMs?: unknown;
    details?: unknown;
  };
  const code = typeof record.code === 'string' && KNOWN_CODES.has(record.code)
    ? (record.code as CommitSourceErrorCode)
    : codeForStatus(status);
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : `Commit service responded ${status}${rawBody ? ` — ${truncate(rawBody)}` : ''}`;
  return new CommitHttpError(code, message, status, {
    ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
    ...(typeof record.details === 'object' && record.details !== null
      ? { details: record.details as Record<string, unknown> }
      : {}),
  });
}
