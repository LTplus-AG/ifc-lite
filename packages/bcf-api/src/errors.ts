/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF's error types, built on the generic OpenCDE Foundation API error types
 * (https://github.com/buildingSMART/foundation-API): an HTTP-level failure
 * carries the same status/url/detail/isAuthError shape for every OpenCDE
 * service, and BCF's token endpoint failures follow the same RFC 6749 shape
 * Documents API auth does.
 *
 * They are thin subclasses rather than aliases so that BOTH ways a BCF error
 * comes to exist keep their historical `name` (#5438 review):
 * - thrown by this package's client/auth code, which is Foundation code
 *   called with `errorNamespace: 'Bcf'`, so named `BcfApiError` /
 *   `BcfAuthenticationError`;
 * - constructed directly, `new BcfApiError(...)`, which goes through the
 *   constructors below.
 * `instanceof` matches on that name, so `error instanceof BcfApiError` holds
 * for both, and a `BcfAuthenticationError` is a `BcfApiError`, as before.
 */

import { FoundationApiError, FoundationAuthenticationError } from '@ifc-lite/opencde-foundation';

const BCF_ERROR_NAMES = new Set(['BcfApiError', 'BcfAuthenticationError']);

/** HTTP-level failure from a BCF server (non-2xx response). */
export class BcfApiError extends FoundationApiError {
  constructor(message: string, options: { status: number; url: string; detail?: string }) {
    super(message, { ...options, namespace: 'Bcf' });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof FoundationApiError && BCF_ERROR_NAMES.has(value.name);
  }
}

/** OAuth2 token endpoint failure (RFC 6749 error responses). */
export class BcfAuthenticationError extends FoundationAuthenticationError {
  constructor(
    message: string,
    options: { status: number; url: string; errorCode?: string; detail?: string },
  ) {
    super(message, { ...options, namespace: 'Bcf' });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof FoundationAuthenticationError && value.name === 'BcfAuthenticationError';
  }
}

export { extractErrorDetail } from '@ifc-lite/opencde-foundation';
