/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cancellation thrown by a job's own runner: anything named `AbortError`
 * (a DOMException from `signal.throwIfAborted()` or `fetch`, Node's
 * AbortError, an abort reason object). A user cancel, not a failure.
 *
 * The one definition the activity journal (`recordActivity`), the store run
 * slot (`slot.run` in `./run-slot.ts`) and `useAsyncRun` classify a throw
 * with, so "cancelled" means the same thing in all three.
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  return 'name' in error && error.name === 'AbortError';
}
