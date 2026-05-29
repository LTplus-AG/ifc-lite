/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a parse promise, unless the load was cancelled.
 *
 * A worker parse started with `waitForEntityIndex` blocks until the streaming
 * geometry pre-pass hands over the entity index. If the geometry loop is
 * cancelled before that handoff, the index never arrives and the parse promise
 * never settles — awaiting it would hang the whole ingest. On abort we instead
 * terminate the worker, abandon (and swallow) the parse promise, and throw an
 * `AbortError` so callers treat it as a clean cancellation (matching the
 * federated loader's `err.name === 'AbortError'` convention).
 */
export async function resolveDataStoreOrAbort<T>(
  parsePromise: Promise<T>,
  opts: { aborted: boolean; terminate?: () => void },
): Promise<T> {
  if (opts.aborted) {
    opts.terminate?.();
    // Swallow the abandoned parse's eventual rejection so it doesn't surface
    // as an unhandled rejection after we've already bailed out.
    void parsePromise.catch(() => {});
    throw new DOMException('Model load aborted', 'AbortError');
  }
  return parsePromise;
}
