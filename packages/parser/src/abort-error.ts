/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build an `AbortError`-shaped error for a cancelled parse. Uses `DOMException`
 * when available (browsers, modern Node) so `err.name === 'AbortError'` matches
 * the same check callers already use for `fetch`/`AbortController` cancellation.
 */
export function makeAbortError(message = 'Parser worker terminated'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError') as unknown as Error;
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
