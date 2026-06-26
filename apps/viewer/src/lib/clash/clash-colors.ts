/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Distinct fill colours for the two elements of a focused clash pair (#1277,
 * #1339). Before this, both clashing elements were highlighted with the single
 * selection colour, so you couldn't tell which was which. We now paint element
 * A and element B in two clearly-different colours (applied through the renderer
 * colour-override channel, with the normal selection outline drawn on top).
 *
 * RGBA floats in 0..1 — the shape `pendingColorUpdates` / `scene.setColorOverrides`
 * consume. Warm vs cool, high contrast on both light and dark themes, and chosen
 * to stay distinguishable for the common red/green colour-vision deficiency
 * (orange vs blue, not red vs green).
 */
export type RGBA = [number, number, number, number];

/** Element A — warm orange. */
export const CLASH_COLOR_A: RGBA = [0.96, 0.45, 0.13, 1];
/** Element B — cool blue. */
export const CLASH_COLOR_B: RGBA = [0.16, 0.5, 0.92, 1];

/**
 * Build the global-id → colour map that paints a clash pair. `null` ids (an
 * element that didn't resolve to a loaded entity) are skipped. The two colours
 * are always distinct so the pair is readable.
 */
export function buildClashPairColors(
  aRef: number | null,
  bRef: number | null,
): Map<number, RGBA> {
  const map = new Map<number, RGBA>();
  if (aRef !== null) map.set(aRef, CLASH_COLOR_A);
  // If both refs resolve to the SAME id (degenerate self-clash), A's colour
  // already won — don't overwrite with B.
  if (bRef !== null && bRef !== aRef) map.set(bRef, CLASH_COLOR_B);
  return map;
}
