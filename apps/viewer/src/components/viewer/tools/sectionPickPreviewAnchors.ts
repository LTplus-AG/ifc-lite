/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World-space anchors for the section face-pick hover preview (issue #243
 * follow-up): the four corners of the little square laid on the hovered face,
 * the foot of the normal arrow, and its tip.
 *
 * Split out of `SectionVisualization.tsx` for #2495. The overlay used to carry
 * its own copy of the in-plane basis derivation with a comment declaring it a
 * duplicate of the renderer's `planeBasis()`, justified as "avoid pulling a
 * renderer dep into the React layer". That justification had already expired —
 * `sectionSlice.ts`, which handles the *committed* pick, imports `planeBasis`
 * from `@ifc-lite/renderer` directly — and the duplicate had drifted into two
 * defects the shared one does not have:
 *
 *  1. its seed axis was world **Z** whenever `|ny| <= 0.9`, so the cross
 *     product against a normal of `[0, 0, ±1]` — an ordinary wall facing the
 *     Z axis, one of the most common face picks there is — was the zero
 *     vector. `Math.hypot(...) || 1` then divided by 1 instead of reporting
 *     the degeneracy, and the preview quad collapsed to a point;
 *  2. `|| 1` answers a question about *length* where the question is about
 *     *finiteness*: `Infinity` is truthy, `Infinity / Infinity` is NaN, so a
 *     non-finite picked normal produced an all-NaN basis and an SVG polygon
 *     with `NaN` coordinates.
 *
 * Routing through the shared basis fixes (1) for free and aligns the preview
 * square with the hatch axes of the cut a click would actually commit — the
 * same call #2494 made for the renderer's billboard bases, where routing to
 * one derivation fixed defects no local floor would have caught. (2) is fixed
 * here, at the seam, by screening the inputs: `planeBasis`'s own `|ny| < 0.9`
 * reference-axis test is only meaningful for a UNIT normal, so normalising
 * before the call is required for correctness, not merely tidy.
 */

import { planeBasis } from '@ifc-lite/renderer';

export type Vec3Tuple = readonly [number, number, number];

export interface SectionPickPreviewAnchors {
  /** Quad corners in (−s,−t), (+s,−t), (+s,+t), (−s,+t) order. */
  corners: [Vec3Tuple, Vec3Tuple, Vec3Tuple, Vec3Tuple];
  /** The picked point itself — where the arrow starts. */
  foot: Vec3Tuple;
  /** `foot + normal * arrowLength`. */
  tip: Vec3Tuple;
}

/** Quad half-extent in metres before the on-screen size clamp. */
export const PREVIEW_HALF_EXTENT_M = 0.5;

/**
 * Arrow length in metres — half a typical wall thickness, enough for the
 * arrowhead to read at default zoom without dwarfing small objects.
 */
export const PREVIEW_ARROW_LENGTH_M = 0.4;

function usableDirection(v: Vec3Tuple): Vec3Tuple | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  // `len > 0` alone admits Infinity and hands back NaN; `Number.isFinite` is
  // the only test that answers the question actually being asked. No lower
  // magnitude floor: a picked normal is a direction, and a short one is still
  // a perfectly good direction once normalised.
  if (!Number.isFinite(len) || len === 0) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Derive the preview anchors, or `null` when the pick carries nothing drawable
 * — a non-finite point, or a normal with no usable direction. `null` means
 * "paint nothing", which is the right answer for a purely advisory hover hint;
 * the committed path (`setSectionPlaneFromFace`) already refuses the same
 * inputs.
 */
export function sectionPickPreviewAnchors(
  point: Vec3Tuple,
  normal: Vec3Tuple,
  halfExtent = PREVIEW_HALF_EXTENT_M,
  arrowLength = PREVIEW_ARROW_LENGTH_M,
): SectionPickPreviewAnchors | null {
  if (!point.every(Number.isFinite)) return null;
  const unit = usableDirection(normal);
  if (!unit) return null;
  if (!Number.isFinite(halfExtent) || !Number.isFinite(arrowLength)) return null;

  const { tangent, bitangent } = planeBasis(unit);
  const [px, py, pz] = point;

  const corner = (s: number, t: number): Vec3Tuple => [
    px + tangent[0] * s + bitangent[0] * t,
    py + tangent[1] * s + bitangent[1] * t,
    pz + tangent[2] * s + bitangent[2] * t,
  ];

  return {
    corners: [
      corner(-halfExtent, -halfExtent),
      corner(halfExtent, -halfExtent),
      corner(halfExtent, halfExtent),
      corner(-halfExtent, halfExtent),
    ],
    foot: [px, py, pz],
    tip: [
      px + unit[0] * arrowLength,
      py + unit[1] * arrowLength,
      pz + unit[2] * arrowLength,
    ],
  };
}
