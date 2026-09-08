/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serializes cloud-source model loads. The WASM parser is not thread-safe, so
 * two `addModel` runs must never interleave: batch downloads (the
 * source-download handler in ViewportContainer) and per-model syncs
 * (syncSourceModel) both route their load work through this one queue, so a
 * Sync clicked mid-batch waits its turn instead of racing the parser.
 *
 * A failed task rejects its caller's promise, but the internal tail always
 * settles fulfilled — the chain can never become permanently rejected and
 * silently skip every later task.
 */
let tail: Promise<void> = Promise.resolve();

export function enqueueSourceLoad<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
