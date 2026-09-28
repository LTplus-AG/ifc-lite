/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one thing a host must be able to learn from a failed commit call
 * without knowing which provider threw it.
 *
 * Providers keep their own `Error` subclasses — the 2.0.0 contract never
 * asked them to give those up, and a provider's own error carries its own
 * diagnostics. They add a `code` property, and the host branches on that:
 * `conflict` means re-read the head and ask the user, `not-ready` means come
 * back after `retryAfterMs`, `forbidden` means say so rather than offering a
 * Retry button that can only fail again.
 *
 * A structural check rather than an exported base class for the same reason
 * `matchesGlob` is shared: a provider must be able to satisfy this contract
 * without importing a runtime value from here, and an `instanceof` across two
 * copies of a package is a bug waiting for a duplicated install.
 */

export type CommitSourceErrorCode =
  | 'not-found'
  | 'forbidden'
  | 'conflict'
  | 'not-ready'
  | 'unsupported-format'
  | 'invalid'
  | 'unavailable';

export interface CommitSourceErrorLike {
  readonly code: CommitSourceErrorCode;
  readonly message: string;
  /** Set with `not-ready`: how long before the host should try again. */
  readonly retryAfterMs?: number;
  /** Code-specific context — `conflict` carries `headCommitId`. */
  readonly details?: Readonly<Record<string, unknown>>;
}

const COMMIT_SOURCE_ERROR_CODES: ReadonlySet<string> = new Set<CommitSourceErrorCode>([
  'not-found',
  'forbidden',
  'conflict',
  'not-ready',
  'unsupported-format',
  'invalid',
  'unavailable',
]);

/**
 * Narrows an unknown `catch` binding to {@link CommitSourceErrorLike}.
 *
 * Deliberately shallow: a `code` in the union and a string `message`. It does
 * NOT require an `Error` instance, because a provider that rejects with a
 * plain object (or one whose error crossed a worker boundary and lost its
 * prototype) is still telling the host everything the host needs.
 */
export function isCommitSourceError(value: unknown): value is CommitSourceErrorLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string'
    && COMMIT_SOURCE_ERROR_CODES.has(candidate.code)
    && typeof candidate.message === 'string';
}
