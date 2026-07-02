/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Distinct, vibrant highlight tints for the two elements of a focused clash
 * pair (#1277, #1339). Before this, both clashing elements were highlighted
 * with the single selection-blue, so you couldn't tell which was which. These
 * feed the renderer's per-element highlight channel (`RenderOptions.highlightColors`),
 * which glows the selected element in this colour using the SAME re-lit
 * selection treatment — so the pair pops like a selection but in two colours.
 *
 * RGBA floats in 0..1. High-chroma warm-vs-cool so they stay distinct from each
 * other, from the default selection-blue, and under red/green colour-vision
 * deficiency (orange vs cyan, not red vs green).
 */
export type RGBA = [number, number, number, number];

/** Element A — vibrant amber/orange. */
export const CLASH_COLOR_A: RGBA = [1.0, 0.5, 0.05, 1];
/** Element B — vibrant cyan. */
export const CLASH_COLOR_B: RGBA = [0.0, 0.82, 1.0, 1];
/** Overlap region wireframe box — vibrant magenta (a third, distinct colour). */
export const CLASH_COLOR_OVERLAP: RGBA = [1.0, 0.1, 0.85, 1];

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
