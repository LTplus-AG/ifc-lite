/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Radius / diameter of picked circular geometry (issue #2737 item 2, split
 * from #2199 §3).
 *
 * # What this measures
 *
 * #2737 names three genuinely different sources for a radius on a tessellated
 * mesh - a cylinder's silhouette, a circular EDGE, and a swept profile's
 * defining radius - and says they will disagree. This module supports
 * exactly one: a circular edge, picked explicitly, point by point, the same
 * way `edge-face-angle.ts` picks an edge as two explicit clicks rather than
 * trying to recover a topological edge from the mesh. `snap-edge-runs.ts:23-30`
 * documents why: arcs are deliberately left UNFUSED, so what a click lands on
 * is one tessellation CHORD, not the edge. Three or more chord endpoints, all
 * picked by the user, is what gets fitted here.
 *
 * The other two sources are out of scope for this pass: a silhouette needs a
 * view-dependent mesh-boundary query this module has no access to, and a
 * swept profile's defining radius needs a parametric read off the IFC
 * geometry (`IfcCircleProfileDef` and friends) rather than off picked points.
 * `RadiusSource` below is shaped so that a later pass can add a
 * `parametric-profile` variant without reshaping the outcome type - see the
 * note on `RadiusSource`.
 *
 * # The gate, and why a residual check alone is not enough
 *
 * The naive approach - least-squares fit a circle, report its radius - fails
 * exactly the way the issue predicts: a Kasa fit (the closed-form algebraic
 * fit used below) does not merely tolerate near-collinear input, it EXPLAINS
 * it almost perfectly with an enormous circle, because a huge-radius arc
 * passes arbitrarily close to points that are nearly on a line. The fit's own
 * RMS residual is therefore near zero for a straight run - it cannot be the
 * refusal signal by itself, or the straight-run case the issue calls out
 * would sail through with a confident 10^6 m answer.
 *
 * What the fit's residual CANNOT hide is missing curvature in the raw picks:
 * the SAGITTA - the perpendicular distance from the interior picks to the
 * chord line through the two extreme picks - is a fit-independent quantity.
 * A straight run has a sagitta of float noise; a real circular edge, sampled
 * at more than one point, does not. So the gate is two checks, in order:
 *
 * 1. **Curvature**: sagitta must clear a floor before a circle fit is even
 *    attempted. Below the floor, this is "no curvature", not "huge radius".
 * 2. **Fit quality**: once curvature is established, the fit's residual must
 *    stay within the same floor (times a small margin for RMS-over-Kasa
 *    noise) - otherwise the points are curved but not circularly so (an
 *    S-bend, a corner, noise), and reporting a circle would fit the wrong
 *    curve confidently.
 *
 * # Where the floor comes from
 *
 * `SAGITTA_FLOOR_M = 100 um`, chosen to sit in the gap between two numbers
 * this codebase already measures, not invented fresh:
 *
 * - **Straight-run noise, ceiling.** A truly straight tessellated edge is
 *   collinear to float precision (~1e-10 m); the worst realistic noise on it
 *   is the snap/weld tolerance floor, `MIN_SNAP_TOLERANCE` in
 *   `packages/renderer/src/snap-weld.ts` (1/65536 m = 15.3 um, the same
 *   constant `edge-face-angle.ts` and `three-point-angle.ts` anchor their own
 *   degenerate-length checks to). 100 um is 6.5x that.
 * - **Genuine-arc curvature, floor.** The tessellator never emits an arc
 *   flatter than it has to: `rust/geometry/src/profiles/curves_2d.rs:134`
 *   caps a general arc's per-chord sagitta at an absolute 0.5 mm
 *   (`CHORD_TOL_M`), and a full circle profile's smallest case -
 *   `calculate_circle_segments` in `rust/geometry/src/profile.rs:286`,
 *   clamped to a minimum of 8 segments - produces a *larger* single-chord
 *   sagitta (381 um at 5 mm radius, per `snap-edge-runs.ts:26-28` and
 *   `packages/renderer/src/snap-geometry-cache.test.ts:128-130`). 100 um is
 *   below both, so a single tessellation chord already clears it, and a
 *   multi-point pick spanning several chords clears it by a wide margin
 *   (sagitta grows with the SQUARE of the span for a fixed radius).
 *
 * So 100 um sits with a 6.5x margin above the straight-run noise ceiling and
 * at least a 3.8x margin below the tessellator's own curvature floor - the
 * gap this codebase's own tessellation numbers leave open.
 */

import { cross, norm, sub, type Point3 } from './angle-vec';

export type { Point3 };

/**
 * Curvature/fit-quality floor, in metres. See the module doc for the two
 * measured numbers (15.3 um straight-run noise, 381 um-0.5 mm tessellator
 * curvature floor) this sits between.
 */
export const SAGITTA_FLOOR_M = 1e-4;

/**
 * Fit-residual budget, expressed as a multiple of {@link SAGITTA_FLOOR_M}.
 *
 * The Kasa fit's RMS residual is noisier than the raw sagitta measurement -
 * it aggregates every pick against a fitted center rather than reading two
 * extremes and a midpoint - so it needs headroom over the same floor rather
 * than the floor itself. 3x keeps it inside the tessellator's own curvature
 * band (up to ~0.5 mm) while still refusing a residual that has drifted onto
 * the order of the fitted radius.
 */
const RESIDUAL_BUDGET = 3;

/** Minimum picks to fit a circle at all: three points determine one exactly. */
export const MIN_RADIUS_POINTS = 3;

/**
 * Where a radius reading came from. Only `fitted-tessellation` is produced by
 * this module today - see the module doc's "What this measures" section.
 * `parametric-profile` is named here, unconstructed, so a later pass that
 * reads `IfcCircleProfileDef` et al. can slot its result into the existing
 * outcome shape rather than inventing a second one; a reader that already
 * handles this union does not need to change when that lands. This mirrors
 * `QuantityBasis` in `quantities.ts`, which keeps `'unqualified'` as its own
 * case rather than defaulting to `'net'` or `'gross'`.
 */
export type RadiusSource =
  | { kind: 'fitted-tessellation'; pointCount: number }
  | { kind: 'parametric-profile'; profileType: string };

/** What a radius-fit attempt resolved to. */
export type RadiusFitOutcome =
  | { kind: 'insufficient-points'; count: number }
  | {
      kind: 'refused';
      reason: 'no-curvature' | 'poor-fit';
      /** Perpendicular deviation of the picks from their own chord, metres. */
      sagittaM: number;
      /** RMS distance of the picks from the (attempted) fitted circle, metres. Absent when refused before a fit was attempted. */
      residualM?: number;
    }
  | {
      kind: 'fitted';
      radiusM: number;
      diameterM: number;
      source: RadiusSource;
      sagittaM: number;
      residualM: number;
    };

/** Perpendicular distance from `p` to the infinite line through `a` and `b`. */
function distanceToLine(p: Point3, a: Point3, b: Point3): number {
  const dir = sub(b, a);
  const len = norm(dir);
  if (!(len > 0)) return norm(sub(p, a));
  return norm(cross(sub(p, a), dir)) / len;
}

/**
 * Sagitta of a point sequence: the largest perpendicular deviation of any
 * point from the chord line through the two points FARTHEST apart in the
 * set. Farthest-apart rather than first/last, so the reading does not depend
 * on the order the user happened to click in.
 */
function sagitta(points: readonly Point3[]): { value: number; a: Point3; b: Point3 } {
  let a = points[0];
  let b = points[0];
  let maxSpan = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = norm(sub(points[j], points[i]));
      if (d > maxSpan) {
        maxSpan = d;
        a = points[i];
        b = points[j];
      }
    }
  }
  let maxSagitta = 0;
  for (const p of points) {
    const d = distanceToLine(p, a, b);
    if (d > maxSagitta) maxSagitta = d;
  }
  return { value: maxSagitta, a, b };
}

/**
 * Best-fit plane normal for a near-planar point set, via the sum of
 * consecutive cross products about the centroid (Newell's method, applied to
 * an open sequence rather than a closed polygon - the picks are not a loop).
 * `null` when the points carry no consistent normal (all collinear).
 */
function planeNormal(points: readonly Point3[], centroid: Point3): Point3 | null {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = sub(points[i], centroid);
    const b = sub(points[(i + 1) % points.length], centroid);
    nx += a.y * b.z - a.z * b.y;
    ny += a.z * b.x - a.x * b.z;
    nz += a.x * b.y - a.y * b.x;
  }
  const n = Math.hypot(nx, ny, nz);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  return { x: nx / n, y: ny / n, z: nz / n };
}

/**
 * Fit a circle to `points` (three or more, expected roughly planar and
 * roughly circular - see the module doc for what "roughly" is bounded by).
 *
 * Refuses via {@link RadiusFitOutcome}'s `insufficient-points` and `refused`
 * cases rather than throwing: a bad measurement is a value the caller
 * renders as "not circular", not an exception a UI has to catch.
 */
export function fitRadius(points: readonly Point3[]): RadiusFitOutcome {
  if (points.length < MIN_RADIUS_POINTS) {
    return { kind: 'insufficient-points', count: points.length };
  }

  const { value: sagittaM } = sagitta(points);
  if (!(sagittaM > SAGITTA_FLOOR_M)) {
    return { kind: 'refused', reason: 'no-curvature', sagittaM };
  }

  const centroid = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length, z: acc.z + p.z / points.length }),
    { x: 0, y: 0, z: 0 },
  );
  const normal = planeNormal(points, centroid);
  if (!normal) {
    return { kind: 'refused', reason: 'no-curvature', sagittaM };
  }

  // Build an in-plane orthonormal basis (u, v) so the fit runs in 2D.
  const seed = Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const uRaw = cross(seed, normal);
  const uLen = norm(uRaw);
  if (!(uLen > 0)) {
    return { kind: 'refused', reason: 'no-curvature', sagittaM };
  }
  const u = { x: uRaw.x / uLen, y: uRaw.y / uLen, z: uRaw.z / uLen };
  const v = cross(normal, u);

  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    const rel = sub(p, centroid);
    xs.push(rel.x * u.x + rel.y * u.y + rel.z * u.z);
    ys.push(rel.x * v.x + rel.y * v.y + rel.z * v.z);
  }

  // Kasa algebraic circle fit: solve the linear least-squares system
  //   2*x*D + 2*y*E + F = x^2 + y^2
  // for (D, E, F) via the normal equations, then recover center/radius.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z; sz += z;
  }

  // Normal-equation matrix for [D, E, F] against [sum 2x*z, sum 2y*z, sum z]:
  //   | sxx sxy sx | |D|   | sxz |
  //   | sxy syy sy | |E| = | syz |
  //   | sx  sy  n  | |F|   | sz  |
  const m00 = sxx, m01 = sxy, m02 = sx;
  const m10 = sxy, m11 = syy, m12 = sy;
  const m20 = sx, m21 = sy, m22 = n;
  const b0 = sxz, b1 = syz, b2 = sz;

  const det =
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20);

  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    return { kind: 'refused', reason: 'no-curvature', sagittaM };
  }

  const detD =
    b0 * (m11 * m22 - m12 * m21) -
    m01 * (b1 * m22 - m12 * b2) +
    m02 * (b1 * m21 - m11 * b2);
  const detE =
    m00 * (b1 * m22 - m12 * b2) -
    b0 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * b2 - b1 * m20);
  const detF =
    m00 * (m11 * b2 - b1 * m21) -
    m01 * (m10 * b2 - b1 * m20) +
    b0 * (m10 * m21 - m11 * m20);

  const D = detD / det;
  const E = detE / det;
  const F = detF / det;

  const cx = D / 2;
  const cy = E / 2;
  const radiusSq = F + cx * cx + cy * cy;
  if (!(radiusSq > 0) || !Number.isFinite(radiusSq)) {
    return { kind: 'refused', reason: 'no-curvature', sagittaM };
  }
  const radiusM = Math.sqrt(radiusSq);

  let sumSqResidual = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(xs[i] - cx, ys[i] - cy) - radiusM;
    sumSqResidual += d * d;
  }
  const residualM = Math.sqrt(sumSqResidual / n);

  if (residualM > SAGITTA_FLOOR_M * RESIDUAL_BUDGET) {
    return { kind: 'refused', reason: 'poor-fit', sagittaM, residualM };
  }

  return {
    kind: 'fitted',
    radiusM,
    diameterM: radiusM * 2,
    source: { kind: 'fitted-tessellation', pointCount: n },
    sagittaM,
    residualM,
  };
}

/**
 * One-line readout for a radius fit. Mirrors `formatAnglePair` /
 * `formatThreePointAngle`: a refusal is spelled out rather than rendered as a
 * number, and a fitted value always carries its provenance so it cannot be
 * mistaken for an exact, parametric reading.
 */
export function formatRadius(outcome: RadiusFitOutcome): string {
  switch (outcome.kind) {
    case 'insufficient-points':
      return `Pick ${MIN_RADIUS_POINTS - outcome.count} more point${MIN_RADIUS_POINTS - outcome.count === 1 ? '' : 's'} on the arc`;
    case 'refused':
      return outcome.reason === 'no-curvature' ? 'Not circular (straight)' : 'Not circular (poor fit)';
    case 'fitted': {
      const r = outcome.radiusM;
      const d = outcome.diameterM;
      const label =
        outcome.source.kind === 'fitted-tessellation'
          ? `fitted from ${outcome.source.pointCount} tessellation points`
          : `read from ${outcome.source.profileType}`;
      return `R ${r.toFixed(3)} m / D ${d.toFixed(3)} m (${label})`;
    }
  }
}
