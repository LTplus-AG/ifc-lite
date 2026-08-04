/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Failure policy for the auto-captured viewport screenshot that a chat turn
 * attaches to the next message.
 *
 * The store slot is written after a script run and consumed (and only then
 * cleared) when the user sends. So a capture that FAILS must not simply be
 * skipped: the slot would still hold the screenshot from an EARLIER run, and
 * the model would be shown a viewport that no longer matches the model state
 * it is being asked about. "No screenshot" is a degrade; "the previous
 * screenshot" is a wrong answer. The resolver therefore always produces the
 * value to store — the new capture, or `null` to clear the stale one.
 */

/** Resolve the screenshot to store, or `null` when there is nothing to attach. */
export function resolveChatViewportScreenshot(
  canvas: HTMLCanvasElement | null,
  capture: (canvas: HTMLCanvasElement) => string,
): string | null {
  if (!canvas) return null;
  try {
    return capture(canvas) || null;
  } catch (err) {
    // `toDataURL` on a tainted canvas (SecurityError) or a lost drawing
    // context. Once per script run that touches geometry — not a hot path.
    console.warn('[chat] viewport screenshot capture failed; sending without one', err);
    return null;
  }
}
