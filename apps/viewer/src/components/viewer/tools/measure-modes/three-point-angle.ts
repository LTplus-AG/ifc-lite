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
 * Percent and ratio express rise over run against a HORIZONTAL reference —
 * that is what makes them meaningful for `inclination.ts`, whose reference is
 * the ground plane. Three arbitrary picks have no such reference: the same
 * 30 degree angle can sit in any orientation, and printing "58%" beside it
 * would attach a gradient reading to a quantity that is not a gradient. The
 * formats belong to the measurement, not to the tool.
 */

import { angleBetweenDeg, normalize, sub, type Point3 } from './angle-vec';

/**
 * Below this the two rays are treated as pointing the same way, or exactly
 * opposite ways, rather than as a very small or very large angle.
 *
 * This is not cosmetic rounding. Picks snap to welded vertices and to the
 * merged collinear runs `snap-edge-runs.ts` reconstructs, so three picks along
 * one straight edge is a REACHABLE input, not a pathological one — the apex
 * lands on an interior junction of a run whose endpoints are the other two
 * picks. Exact 180 never survives the f32 round trip, so without a band that
 * case reports something like 179.9997 degrees and the reader is left to
 * decide whether that is a real dogleg.
 */
const COLLINEAR_TOLERANCE_DEG = 0.01;

/** Below this a ray has no direction: the apex and that pick coincide. */
const DEGENERATE_LENGTH_M = 1e-9;

/**
 * Which of the four genuinely different answers three picks have.
 *
 * `degenerate` and `zero` both produce 0 degrees, so a formatter without a
 * discriminator would have to render "I measured nothing" and "I measured a
 * real zero angle" identically — the same trap `InclinationKind` exists to
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
   * plane the three picks do not carry. Unfolded — 120 stays 120 rather than
   * folding to 60 — because the apex makes the answer directed: the user
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
  collinearToleranceDeg: number = COLLINEAR_TOLERANCE_DEG,
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

  if (degrees <= collinearToleranceDeg) return { kind: 'zero', degrees: 0 };
  if (degrees >= 180 - collinearToleranceDeg) return { kind: 'straight', degrees: 180 };
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
      return '—';
    case 'zero':
      return '0.0°';
    case 'straight':
      return '180.0°  straight';
    case 'angled':
      return `${r.degrees.toFixed(1)}°`;
  }
}
