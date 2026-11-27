/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two-point align (#11505), as in CAD ALIGN: two point pairs fix a heading and
 * a move. A and B sit on the moving model, A' and B' on the reference; A is
 * meant to land on A', and the direction A->B on A'->B'.
 *
 * Everything is engineering workspace frame, metres, Z up (the frame
 * `translation.ts` calls `Translation`); no render (Y-up) axes appear here.
 *
 * SIGN CONVENTION — the same one as `ModelRotation` and `rotateWorkspacePoint`:
 * `heading` is radians, positive counter-clockwise seen from above (X turns
 * toward Y). So `heading = atan2(B'-A' in plan) - atan2(B-A in plan)`, and
 * `rotateWorkspacePoint(p, { angle: heading, pivot: A })` followed by adding
 * `delta` sends A to A'.
 */
import { finiteTranslation, type Translation } from './translation.js';

/** Plan (XY) separation under which a pair gives no usable direction. */
export const MIN_PLAN_SEPARATION_M = 1e-3;

export interface TwoPointAlignInput {
  /** A and B on the moving model, A' and B' on the reference. */
  a: Translation;
  b: Translation;
  aPrime: Translation;
  bPrime: Translation;
}

export type TwoPointAlignRefusal =
  /** A coordinate is not a finite number. */
  | 'non-finite'
  /** A and B coincide in plan: the moving model's direction is undefined. */
  | 'moving-pair-degenerate'
  /** A' and B' coincide in plan: the reference direction is undefined. */
  | 'reference-pair-degenerate';

/** How well the transform reproduces the second pair. */
export interface TwoPointAlignCheck {
  /** Metres between where B lands and B' (3D, so a Z mismatch counts). */
  distance: number;
  /** Plan length |A->B| / |A'->B'|; 1 when the two pairs agree in scale/units. */
  planRatio: number;
  /** Elevation difference of the segments, (B'z - A'z) - (Bz - Az), metres. */
  deltaZ: number;
}

export interface TwoPointAlignment {
  /** Radians in (-PI, PI], positive counter-clockwise from above, about A. */
  heading: number;
  /** The rotation axis: A, as given. */
  pivot: Translation;
  /** The move that follows the rotation about A: A' - A. */
  delta: Translation;
  /** Plan distance from A to B, in metres. */
  movingPlanLength: number;
  check: TwoPointAlignCheck;
}

export type TwoPointAlignResult =
  | { ok: true; alignment: TwoPointAlignment }
  | { ok: false; reason: TwoPointAlignRefusal };

const TWO_PI = Math.PI * 2;

/** Same wrap as `normalizeAngle` (rotation.ts) but total: -PI folds to +PI. */
function wrapHeading(radians: number): number {
  const wrapped = radians - TWO_PI * Math.floor((radians + Math.PI) / TWO_PI);
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export function alignTwoPoints(input: TwoPointAlignInput): TwoPointAlignResult {
  const { a, b, aPrime, bPrime } = input;
  if (![a, b, aPrime, bPrime].every(finiteTranslation)) return { ok: false, reason: 'non-finite' };
  // Work on differences: at 1e6 m the absolute coordinates carry ~1e-10 m of
  // double rounding, the differences carry none beyond it.
  const abX = b[0] - a[0], abY = b[1] - a[1], abZ = b[2] - a[2];
  const refX = bPrime[0] - aPrime[0], refY = bPrime[1] - aPrime[1], refZ = bPrime[2] - aPrime[2];
  const movingPlan = Math.hypot(abX, abY), referencePlan = Math.hypot(refX, refY);
  if (movingPlan < MIN_PLAN_SEPARATION_M) return { ok: false, reason: 'moving-pair-degenerate' };
  if (referencePlan < MIN_PLAN_SEPARATION_M) return { ok: false, reason: 'reference-pair-degenerate' };
  // atan2 of the cross and dot products is the signed angle between the two
  // plan vectors in one step, without subtracting two near-pi atan2 results.
  const heading = wrapHeading(Math.atan2(abX * refY - abY * refX, abX * refX + abY * refY));
  const cos = Math.cos(heading), sin = Math.sin(heading);
  // Where B lands relative to A' (A lands on A'), then its offset from B'.
  const landedX = abX * cos - abY * sin, landedY = abX * sin + abY * cos;
  const distance = Math.hypot(landedX - refX, landedY - refY, abZ - refZ);
  return { ok: true, alignment: {
    heading,
    pivot: [a[0], a[1], a[2]],
    delta: [aPrime[0] - a[0], aPrime[1] - a[1], aPrime[2] - a[2]],
    movingPlanLength: movingPlan,
    check: { distance, planRatio: movingPlan / referencePlan, deltaZ: refZ - abZ },
  } };
}

/** The check's own thresholds, shared by the readout and its tests. */
export const CHECK_WARN_DISTANCE_M = 0.01;
export const CHECK_WARN_RATIO_TOLERANCE = 0.001;

export function checkNeedsWarning(check: TwoPointAlignCheck): boolean {
  return check.distance > CHECK_WARN_DISTANCE_M;
}

export function scaleRatioIsOff(check: TwoPointAlignCheck): boolean {
  return Math.abs(check.planRatio - 1) > CHECK_WARN_RATIO_TOLERANCE;
}
