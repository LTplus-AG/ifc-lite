/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** How long to wait for an abandoned geometry iterator to shut down before
 *  giving up on it. Generous enough for a healthy generator to run its
 *  `finally` (freeing WASM handles, terminating workers), short enough that a
 *  wedged one never holds the caller hostage. */
export const GEOMETRY_ITERATOR_CLEANUP_MS = 2000;

interface ClosableAsyncIterator {
  return?: (value?: unknown) => Promise<unknown> | unknown;
}

/**
 * Abandon an async iterator without letting its shutdown wedge the caller.
 *
 * `AsyncIterator.return()` cannot interrupt a generator parked on an unresolved
 * `await` — e.g. the geometry drain loop suspended waiting on a worker that
 * failed to instantiate ("Worker from an empty source") and therefore never
 * resolves the promise. Awaiting `return()` unbounded would re-block on the
 * exact stall the stream watchdog just escaped, swallowing the timeout error so
 * the load hangs in cleanup instead of surfacing a recoverable failure. Racing
 * it against a deadline guarantees the caller always proceeds; a healthy
 * generator still resolves well within the deadline so its `finally` runs.
 */
export async function boundedIteratorReturn(
  iterator: ClosableAsyncIterator,
  cleanupMs: number = GEOMETRY_ITERATOR_CLEANUP_MS,
): Promise<void> {
  if (typeof iterator.return !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve(iterator.return(undefined)).catch(() => {
        /* cleanup — safe to ignore */
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, cleanupMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
