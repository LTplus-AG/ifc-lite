/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitSourceErrorCode } from '@ifc-lite/plugin-api';

/**
 * Error thrown by the fixture provider for both genuine contract violations
 * (unknown id, mismatched container, malformed cursor) and injected failures
 * (`kind: 'throw'` / `'rate-limit'`). Carries an HTTP-shaped `status` so host
 * error-handling code can be exercised the same way it would be against a
 * real CDE's 4xx/5xx responses.
 */
export class FixtureApiError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'FixtureApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A `FixtureApiError` carrying a `code` so `isCommitSourceError` narrows it. */
export class FixtureCommitError extends FixtureApiError {
  readonly code: CommitSourceErrorCode;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CommitSourceErrorCode,
    message: string,
    extra?: { readonly status?: number; readonly retryAfterMs?: number; readonly details?: Readonly<Record<string, unknown>> },
  ) {
    super(message, extra?.status);
    this.name = 'FixtureCommitError';
    this.code = code;
    if (extra?.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra?.details !== undefined) this.details = extra.details;
  }
}

/** Builds the same `AbortError` shape a real `fetch` rejects with. */
export function toAbortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Never resolves — settles only by rejecting once `signal` aborts. Used to
 * make the `'hang'` failure kind exercise a provider's real abort wiring
 * instead of a fake timeout standing in for "the network never comes back".
 * A caller that passes no `signal` gets a promise that never settles at all,
 * which is deliberate: it proves the test *must* supply one to observe abort
 * handling, rather than silently timing out on its own schedule.
 */
export function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(toAbortError(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(toAbortError(signal)), { once: true });
  });
}
