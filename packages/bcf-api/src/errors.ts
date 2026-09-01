/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** HTTP-level failure from a BCF server (non-2xx response). */
export class BcfApiError extends Error {
  /** HTTP status code; 0 when the request never produced a response. */
  readonly status: number;
  /** Request URL with any query string, for diagnostics. */
  readonly url: string;
  /** Server-provided error detail, when the body carried one. */
  readonly detail?: string;

  constructor(message: string, options: { status: number; url: string; detail?: string }) {
    super(message);
    this.name = 'BcfApiError';
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
export class BcfAuthenticationError extends BcfApiError {
  /** RFC 6749 error code, e.g. 'invalid_grant' or 'invalid_request'. */
  readonly errorCode?: string;

  constructor(
    message: string,
    options: { status: number; url: string; errorCode?: string; detail?: string },
  ) {
    super(message, options);
    this.name = 'BcfAuthenticationError';
    this.errorCode = options.errorCode;
  }
}

/**
 * Extract a human-readable message from a BCF server error body. Servers
 * vary: BCF API prescribes `{message}`, OAuth2 uses `{error, error_description}`,
 * FastAPI emits `{detail}`.
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
