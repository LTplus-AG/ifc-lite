/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a face-picked section plane is committed (#5480).
 *
 * A plane laid exactly THROUGH the picked face makes every fragment of that
 * face sit at `dot(p, n) - d = 0 ± rounding`. The clip shader's sign test on
 * that value is a coin toss per pixel, and the section cap, drawn on the same
 * plane, ties with the surviving fragments in depth: the whole face renders as
 * face-coloured / cap-coloured speckle. The cut polygon the 2D drawing and the
 * cap are built from is also a degenerate, coplanar cut rather than a section.
 *
 * So the committed plane is pushed a small inset INTO the picked solid, along
 * the camera-oriented pick normal (`selectionHandlers.ts` orients it toward the
 * viewer, i.e. out of the visible surface). The face then lies strictly on one
 * side of the plane: with the default kept side it is clipped away and the
 * cap shows the element's cross-section; flipped, it is kept whole and the cap
 * sits cleanly behind it. Either way nothing is coplanar.
 *
 * The inset is in viewer world units, which are metres (geometry is unit-scaled
 * at parse time), and has two floors:
 *  - absolute: twice the renderer's quantized-vertex lattice step
 *    (`QUANT_STEP`, 2^-10 m). A quantized batch draws each vertex up to half a
 *    step per axis away from where the raycast measured it, so the face as
 *    drawn can sit ~0.85 mm off the picked point along a tilted normal; two
 *    steps clears that with margin while staying under a thin pane's
 *    half-thickness.
 *  - relative: 2^-16 of the coordinate magnitude in play (the picked point and
 *    the model bounds), i.e. 256 f32 ulps. Unrebased or very large scenes
 *    store and interpolate positions with a proportionally coarser f32 grid,
 *    and a fixed millimetre would disappear into it.
 * It is capped at 5 cm (the offset the #5480 report showed renders a clean
 * cap), so a degenerate scale can never push the cut through a whole element.
 */

import { QUANT_STEP } from '@ifc-lite/renderer';
import type { SectionPlane } from '../types.js';

/** Absolute inset floor, in metres: two quantized-vertex lattice steps. */
export const FACE_PICK_MIN_INSET_M = 2 * QUANT_STEP;
/** Relative inset: fraction of the coordinate magnitude (256 f32 ulps). */
export const FACE_PICK_RELATIVE_INSET = 2 ** -16;
/** Upper bound on the inset, in metres. */
export const FACE_PICK_MAX_INSET_M = 0.05;

type Vec3 = readonly [number, number, number];

/** How far into the solid a face-picked plane is placed, for this pick. */
export function facePickInset(point: Vec3, bounds?: { min: Vec3; max: Vec3 }): number {
  let scale = Math.max(Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
  if (bounds) {
    for (const v of [...bounds.min, ...bounds.max]) {
      if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
    }
  }
  return Math.min(FACE_PICK_MAX_INSET_M, Math.max(FACE_PICK_MIN_INSET_M, scale * FACE_PICK_RELATIVE_INSET));
}

/**
 * Committed plane distance for a face pick: the face's own `dot(point, n)`
 * minus the inset, so the plane lies inside the solid behind the picked
 * surface. `unit` must be the unit, camera-oriented pick normal.
 */
export function facePickPlaneDistance(unit: Vec3, point: Vec3, bounds?: { min: Vec3; max: Vec3 }): number {
  const faceDistance = point[0] * unit[0] + point[1] * unit[1] + point[2] * unit[2];
  return faceDistance - facePickInset(point, bounds);
}

/**
 * `flipped` for a reader that approximates the cut by its cardinal `axis` /
 * `position` (BCF viewpoints, SDK `getSection()`/`setSection()`, Reset to
 * axis), where the flip is relative to the +axis normal. A face-picked plane's `flipped` is relative to its own
 * `custom.normal` (that is how the renderer applies it), so a normal that
 * points down the negative axis inverts it (#5644).
 */
export function cardinalSectionFlipped(plane: Pick<SectionPlane, 'axis' | 'flipped' | 'custom'>): boolean {
  if (!plane.custom) return plane.flipped;
  const along = plane.custom.normal[plane.axis === 'side' ? 0 : plane.axis === 'down' ? 1 : 2];
  return plane.flipped !== (along < 0);
}
