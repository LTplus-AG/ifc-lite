/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialize an async refresh while coalescing requests that arrive in flight
 * into one fresh follow-up pass. Callers that hit an active pass return after
 * recording demand; the active caller owns the complete drain loop.
 */
export function createCoalescingRunner(
  canRun: () => boolean,
  runOnce: () => Promise<void>,
): () => Promise<void> {
  let running = false;
  let requested = false;
  return async () => {
    if (!canRun()) return;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    try {
      do {
        requested = false;
        await runOnce();
      } while (requested && canRun());
    } finally {
      running = false;
    }
  };
}
