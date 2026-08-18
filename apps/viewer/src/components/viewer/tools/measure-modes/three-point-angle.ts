/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-point angle: the angle AT an apex, between rays to two other picks
 * (#2735, split from #2199 §4).
 *
 * Pure display maths over three stored points, exactly like `inclination.ts`
 * and `polyline.ts`: nothing is persisted beyond the picks themselves, so a
 * correction here retroactively fixes every measurement already on screen.
 *
 * WHY ONLY DEGREES. #2199 asked for degrees, percent slope and 1:n ratio.
 * Percent and ratio express rise over run against a HORIZONTAL reference -
 * that is what makes them meaningful for `inclination.ts`, whose reference is
 * the ground plane. Three arbitrary picks have no such reference: the same
 * 30 degree angle can sit in any orientation, and printing "58%" beside it
 * would attach a gradient reading to a quantity that is not a gradient. The
 * formats belong to the measurement, not to the tool.
 */

import { angleBetweenDeg, cross, dot, norm, normalize, sub, type Point3 } from './angle-vec';

/**
 * Pick resolution: the snap layer's own floor, `MIN_SNAP_TOLERANCE` in
 * `packages/renderer/src/snap-weld.ts` (the CSG kernel's reconcile grid,
 * 1/65536 m = 15.3 um). Mirrored rather than imported because this module is
 * pure display maths with no renderer dependency; the sibling test pins the
 * two together.
 *
 * Two picks closer than this are the SAME pick as far as the snap layer is
 * concerned: vertex snapping returns the WELDED REPRESENTATIVE point, so two
 * picks on one vertex come back byte-identical, and two distinct snapped
 * picks are at least this far apart.
 */
const PICK_RESOLUTION_M = 1 / 65536;

/**
 * Below this a ray has no usable direction.
 *
 * Tied to pick resolution, NOT to an arbitrarily small epsilon. An earlier
 * version used 1e-9 m, which is 15,259x BELOW the snap floor, so no
 * reachable input could ever land in the band (0, 1e-9]: the guard
 * classified nothing, and the test that "pinned it from both sides" pinned a
 * constant with no behavioural consequence. A ray shorter than one pick resolution has a
 * direction made entirely of cursor noise, and that is what is worth
 * refusing to measure.
 */
const DEGENERATE_LENGTH_M = PICK_RESOLUTION_M;

/**
 * Collinearity is judged as a PERPENDICULAR DISTANCE, not as an angle.
 *
 * `snap-weld.ts:43-54` makes this argument and this module follows it: "An
 * angle tolerance would be the wrong primitive here", because a fixed angle is
 * simultaneously too tight for short rays far from the origin and too loose
 * for long ones near it. Measured against the snap layer's own noise, a fixed
 * 0.01 degree band is ESCAPED by a genuinely straight triple at 100 m
 * coordinates with 10 cm rays (~0.014 degrees of direction noise), while at
 * 2 m rays the same band is ~14x wider than the noise and folds real
 * sub-millimetre doglegs into "straight".
 *
 * So: the far pick is collinear when its perpendicular offset from the
 * apex->a line is within pick resolution. That scales with ray length for
 * free, and is expressed in the unit the snap layer actually guarantees.
 */
const COLLINEAR_OFFSET_M = PICK_RESOLUTION_M;

/**
 * Which of the four genuinely different answers three picks have.
 *
 * `degenerate` and `zero` both produce 0 degrees, so a formatter without a
 * discriminator would have to render "I measured nothing" and "I measured a
 * real zero angle" identically - the same trap `InclinationKind` exists to
 * avoid.
 */
export type ThreePointAngleKind =
  /** A ray has no length: the apex coincides with one of the other picks. */
  | 'degenerate'
  /** Both rays point the same way: a real 0 degrees. */
  | 'zero'
  /** The picks are collinear with the apex between them: a real 180 degrees. */
  | 'straight'
  /** A real angle strictly between 0 and 180. */
  | 'angled';

export interface ThreePointAngle {
  kind: ThreePointAngleKind;
  /**
   * The angle at the apex in degrees, always in [0, 180].
   *
   * UNSIGNED and unfolded. Unsigned because a sign would need a reference
   * plane the three picks do not carry. Unfolded - 120 stays 120 rather than
   * folding to 60 - because the apex makes the answer directed: the user
   * pointed at a specific corner, and reporting its supplement would answer a
   * question they did not ask. (Edge-to-edge angle, where no apex is picked,
   * is the case that genuinely has to fold; see #2735's later slice.)
   */
  degrees: number;
}

/**
 * Angle at `apex` between the rays `apex -> a` and `apex -> b`.
 *
 * The apex is the FIRST argument because it is the first pick: the user picks
 * the corner, then the two directions from it.
 */
export function threePointAngle(
  apex: Point3,
  a: Point3,
  b: Point3,
  degenerateLengthM: number = DEGENERATE_LENGTH_M,
  collinearOffsetM: number = COLLINEAR_OFFSET_M,
): ThreePointAngle {
  const ra = sub(a, apex);
  const rb = sub(b, apex);

  // Guard BEFORE normalising: a zero-length ray has no direction, and
  // `normalize` would hand back null for it anyway. Checking length here lets
  // the caller tune the threshold in metres, which is the unit picks arrive in.
  const ua = normalize(ra);
  const ub = normalize(rb);
  if (!ua || !ub || Math.hypot(ra.x, ra.y, ra.z) <= degenerateLengthM || Math.hypot(rb.x, rb.y, rb.z) <= degenerateLengthM) {
    return { kind: 'degenerate', degrees: 0 };
  }

  const degrees = angleBetweenDeg(ua, ub);

  // Perpendicular offset of b from the apex->a line. `ua` is unit, so
  // |ua x rb| IS that distance - no division, and it scales with rb's length
  // exactly as the tolerance argument above requires.
  if (norm(cross(ua, rb)) <= collinearOffsetM) {
    // Collinear. Which of the two collinear answers is a question of
    // DIRECTION, which a perpendicular offset cannot tell apart.
    return dot(ua, ub) >= 0 ? { kind: 'zero', degrees: 0 } : { kind: 'straight', degrees: 180 };
  }
  return { kind: 'angled', degrees };
}

/**
 * One-line readout, e.g. `36.9°`.
 *
 * `degenerate` renders an em dash rather than `0.0°`, following
 * `formatInclination`: nothing was measured, so claiming a zero angle would
 * state a fact the picks never established.
 */
export function formatThreePointAngle(r: ThreePointAngle): string {
  switch (r.kind) {
    case 'degenerate':
      return '-';
    case 'zero':
      return '0.0°';
    case 'straight':
      return '180.0°  straight';
    case 'angled':
      return `${r.degrees.toFixed(1)}°`;
  }
}
