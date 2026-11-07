/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One tolerance for a touch tap and the events that trail it (#9091). A touch
 * stays a tap while it drifts no more than `TAP_SLOP_PX` per axis; it acts at
 * its press point, but its compatibility click lands where it lifted. So the
 * guards that drop that click, and that let a mouse or trackpad press there
 * keep its own, use the same slop.
 */
export const TAP_SLOP_PX = 10;

/** How long after a touch-owned tap its compatibility click, dblclick or context menu may still come. */
export const TAP_CLICK_MS = 700;

/** Within the tap slop of `at`, per axis. */
export function withinTapSlop(x: number, y: number, at: { x: number; y: number }): boolean {
  return Math.abs(x - at.x) <= TAP_SLOP_PX && Math.abs(y - at.y) <= TAP_SLOP_PX;
}
