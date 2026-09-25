/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `namespace` sets the error's `name` (`<namespace>ApiError`,
 * `<namespace>AuthenticationError`; default `Foundation`). A concrete client
 * re-exports these classes under its own names (BCF's `BcfApiError`), and
 * its errors must keep reporting that name: callers serialize and dispatch
 * on `error.name`, not only on `instanceof` (#5438 review).
 */
/** HTTP-level failure from an OpenCDE server (non-2xx response). */
export class FoundationApiError extends Error {
  /** HTTP status code; 0 when the request never produced a response. */
  readonly status: number;
  /** Request URL with any query string, for diagnostics. */
  readonly url: string;
  /** Server-provided error detail, when the body carried one. */
  readonly detail?: string;

  constructor(message: string, options: { status: number; url: string; detail?: string; namespace?: string }) {
    super(message);
    this.name = `${options.namespace ?? 'Foundation'}ApiError`;
    this.status = options.status;
    this.url = options.url;
    this.detail = options.detail;
  }

  /** True when the server rejected the credentials (sign in again). */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** OAuth2 token endpoint failure (RFC 6749 error responses). */
export class FoundationAuthenticationError extends FoundationApiError {
  /** RFC 6749 error code, e.g. 'invalid_grant' or 'invalid_request'. */
  readonly errorCode?: string;

  constructor(
    message: string,
    options: { status: number; url: string; errorCode?: string; detail?: string; namespace?: string },
  ) {
    super(message, options);
    this.name = `${options.namespace ?? 'Foundation'}AuthenticationError`;
    this.errorCode = options.errorCode;
  }
}

/**
 * Extract a human-readable message from an OpenCDE server error body.
 * Servers vary: the Foundation API prescribes `{message}` (see
 * `schemas/error.json`), OAuth2 uses `{error, error_description}`, FastAPI
 * emits `{detail}`.
 */
export function extractErrorDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'error_description', 'detail', 'error']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
