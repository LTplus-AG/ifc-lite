/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mark `promise`'s rejection as observed WITHOUT consuming it.
 *
 * Lifecycle promises such as `whenSynced` reject when their owner is torn
 * down before they settle. Plenty of callers never await them (a session
 * built and disposed without waiting for sync), and an unobserved rejection
 * there is an `unhandledrejection` that crashes Node test runs. The
 * attached branch is a detached copy: every caller that does await the
 * original promise still receives the rejection.
 */
export function markRejectionHandled(promise: Promise<unknown>): void {
  promise.then(undefined, () => undefined);
}
