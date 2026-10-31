/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every failure the client reports carries one of these codes, so a caller
 * can branch on the class of failure without parsing messages.
 *
 * - `INVALID_REFERENCE`: the reference (or an `OciReference` built by hand)
 *   does not follow the distribution grammar, or names an `http:` origin the
 *   caller did not list as insecure.
 * - `NOT_FOUND`: the registry answered 404.
 * - `UNAUTHORIZED`: no usable credentials, or the registry still answered 401
 *   after the client authenticated once.
 * - `DENIED`: the registry (or its token service) answered 403.
 * - `DIGEST_MISMATCH`: the received bytes do not hash to the expected digest.
 * - `SIZE_EXCEEDED`: a body grew past its cap; the transfer was aborted.
 * - `UNSUPPORTED_MANIFEST`: the manifest media type is not one of the four
 *   this client understands.
 * - `PROTOCOL`: the server broke the protocol (bad JSON, bad redirect, bad
 *   `Link`, wrong size, ...).
 * - `NETWORK`: `fetch` itself rejected.
 */
export type OciErrorCode =
  | 'INVALID_REFERENCE'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'DENIED'
  | 'DIGEST_MISMATCH'
  | 'SIZE_EXCEEDED'
  | 'UNSUPPORTED_MANIFEST'
  | 'PROTOCOL'
  | 'NETWORK';

/**
 * The single error type this package throws for registry and data failures.
 * Messages name URLs and digests but never credentials or tokens.
 */
export class OciError extends Error {
  readonly code: OciErrorCode;
  readonly status?: number;

  constructor(code: OciErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OciError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** Maps a non-success registry status to the matching error. */
export function statusError(status: number, what: string): OciError {
  if (status === 401) return new OciError('UNAUTHORIZED', `${what}: registry answered 401 Unauthorized`, { status });
  if (status === 403) return new OciError('DENIED', `${what}: registry answered 403 Forbidden`, { status });
  if (status === 404) return new OciError('NOT_FOUND', `${what}: registry answered 404 Not Found`, { status });
  return new OciError('PROTOCOL', `${what}: unexpected HTTP status ${status}`, { status });
}
