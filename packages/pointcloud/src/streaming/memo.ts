/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Memoise a one-shot async factory, retrying after failure.
 *
 * Concurrent callers share a single in-flight promise (the point of the
 * memo — one wasm fetch, not one per `open()`), and a fulfilled value is
 * cached forever. A *rejection* clears the memo so a transient failure
 * does not poison every future call: the next caller retries. The same
 * fix exists in `@ifc-lite/query`'s `duckdb-integration.ts`.
 *
 * There is deliberately no backoff. Retries here are driven by a user
 * re-opening a file rather than by a polling loop, and callers that open
 * several files at once already collapse onto the one in-flight promise.
 */
export function memoizeAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    // `Promise.resolve().then(factory)` defers the call by a microtask so
    // the `catch` below can never run before `pending` has been assigned —
    // which is what would happen if `factory` threw synchronously.
    pending ??= Promise.resolve().then(factory).catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
