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
 * Check 2 has NO reach at exactly {@link MIN_RADIUS_POINTS} picks, and the
 * gate is one check there, not two. Three non-collinear points lie exactly on
 * one circle, so the fit is interpolation rather than regression: `residualM`
 * is identically zero (float noise aside) and its refusal branch cannot be
 * taken. A three-pick reading is therefore only as good as the picks: over
 * 500 trials of a true 20 m radius picked three times across a 0.30 m span,
 * one `MIN_SNAP_TOLERANCE` of noise each, this reported 19.098 m to 21.003 m
 * and refused none of them. The millimetres `formatRadius` prints there are
 * the fit's precision, not the measurement's. Curvature (check 1) still
 * guards the straight-run case the issue is about, at every count. Four or
 * more picks overdetermine the circle, and only there does check 2 start
 * doing work.
 *
 * # Why the pick order must not reach the arithmetic
 *
 * A radius is a property of the picked point SET. Users do not click an arc
 * in order: clicking three points, noticing a gap and going back to fill it
 * is an ordinary gesture, and nothing in the panel discourages it. So every
 * quantity here is computed from the set alone - `sagitta` spans the two
 * points FARTHEST apart rather than the first and last, `planeNormal` fits a
 * covariance plane rather than summing consecutive cross products, and
 * `canonicalOrder` fixes the summation order so the answer is bit-identical
 * under permutation instead of merely close. `planeNormal`'s doc has the
 * failure this last point is not paranoia about: an order-dependent plane
 * turned a 2 m arc into a 2.8 km one, and BOTH gate checks passed while it
 * did.
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
 *
 * Only meaningful above {@link MIN_RADIUS_POINTS}: at three picks the circle
 * is interpolated, not fitted, and the residual is zero whatever the picks
 * are. See the module doc's gate section.
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
 * Canonical (lexicographic x, then y, then z) ordering of a pick set.
 *
 * Every number this module reports is a property of the SET of picked points,
 * never of the sequence the user clicked them in - see the module doc's
 * "Why the pick order must not reach the arithmetic". Sorting once, here, is
 * what makes that literally true rather than true-up-to-rounding: floating
 * point addition is not associative, so a centroid, a covariance sum or a
 * Kasa moment accumulated in click order differs in its last bits from the
 * same sum accumulated in another order. Feeding every downstream loop one
 * order derived from the point set alone makes the whole fit bit-identical
 * under permutation, which is a property a test can assert exactly.
 *
 * The order itself carries no meaning - it is not "along the arc" and is not
 * used as one. Two exactly coincident picks compare equal and sum
 * identically either way, so ties need no further tie-break.
 */
function canonicalOrder(points: readonly Point3[]): Point3[] {
  return [...points].sort((p, q) => p.x - q.x || p.y - q.y || p.z - q.z);
}

/**
 * In-place Jacobi rotation zeroing the `(p, q)` off-diagonal of the symmetric
 * 3x3 `a`, accumulating the same rotation into the eigenvector matrix `v`.
 */
function jacobiRotate(a: number[][], v: number[][], p: number, q: number): void {
  const apq = a[p][q];
  if (apq === 0) return;
  const theta = (a[q][q] - a[p][p]) / (2 * apq);
  const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
  const c = 1 / Math.sqrt(t * t + 1);
  const s = t * c;
  for (let k = 0; k < 3; k++) {
    const akp = a[k][p];
    const akq = a[k][q];
    a[k][p] = c * akp - s * akq;
    a[k][q] = s * akp + c * akq;
  }
  for (let k = 0; k < 3; k++) {
    const apk = a[p][k];
    const aqk = a[q][k];
    a[p][k] = c * apk - s * aqk;
    a[q][k] = s * apk + c * aqk;
  }
  for (let k = 0; k < 3; k++) {
    const vkp = v[k][p];
    const vkq = v[k][q];
    v[k][p] = c * vkp - s * vkq;
    v[k][q] = s * vkp + c * vkq;
  }
}

/**
 * Best-fit plane normal for a near-planar point set: the eigenvector of the
 * smallest eigenvalue of the picks' covariance matrix about their centroid,
 * i.e. the direction of least spread. That IS the total-least-squares plane -
 * the one minimising the sum of squared perpendicular distances from the
 * picks - and it is a function of the point SET: covariance is a sum of
 * per-point outer products, so no term of it refers to a point's neighbour,
 * its index, or the sequence it arrived in.
 *
 * This replaces a Newell sum over consecutive picks, which read the pick
 * order and could not do otherwise. Newell computes the area vector of the
 * POLYGON through the points in the order given; on a pick sequence that
 * traces a self-intersecting path the lobes have opposing winding and their
 * area vectors cancel, collapsing the sum toward zero and leaving
 * out-of-plane noise as the surviving direction. Four picks clicked
 * A, B, D, C - three along an arc, then back to fill the gap - is enough to
 * do it, and neither half of the gate above can see it happen: the sagitta
 * is measured on the raw 3D picks and never consults the plane, while the
 * residual is near zero precisely BECAUSE the points really do sit on the
 * huge circle a collapsed basis fits them with. Exactly coplanar picks make
 * the same sum cancel to exactly zero, which refused a perfect circle as
 * "not circular (straight)".
 *
 * The eigenvector's SIGN is arbitrary (a plane has two unit normals, and the
 * fit is invariant under the handedness flip that swapping them causes), so
 * it is pinned to a canonical choice here rather than left to the solver.
 *
 * `null` when the picks have no spread at all to fit a plane to; a collinear
 * run is already refused by the sagitta check before this is reached.
 */
function planeNormal(points: readonly Point3[], centroid: Point3): Point3 | null {
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const d = sub(p, centroid);
    xx += d.x * d.x;
    xy += d.x * d.y;
    xz += d.x * d.z;
    yy += d.y * d.y;
    yz += d.y * d.z;
    zz += d.z * d.z;
  }
  const trace = xx + yy + zz;
  if (!Number.isFinite(trace) || !(trace > 0)) return null;

  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  // Cyclic Jacobi. A symmetric 3x3 has only three off-diagonals, so a handful
  // of sweeps drives them to rounding noise; the bound is a guard against a
  // pathological input spinning forever, not an expected iteration count.
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (!(off > trace * Number.EPSILON)) break;
    jacobiRotate(a, v, 0, 1);
    jacobiRotate(a, v, 0, 2);
    jacobiRotate(a, v, 1, 2);
  }

  let min = 0;
  if (a[1][1] < a[min][min]) min = 1;
  if (a[2][2] < a[min][min]) min = 2;
  const n = Math.hypot(v[0][min], v[1][min], v[2][min]);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  let normal = { x: v[0][min] / n, y: v[1][min] / n, z: v[2][min] / n };

  // Canonical sign: the largest-magnitude component is made positive, with
  // x before y before z when magnitudes tie. Which component wins a tie does
  // not matter - the fit is invariant under the flip either way - only that
  // the same point set always gets the same answer.
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  const lead = ax >= ay && ax >= az ? normal.x : ay >= az ? normal.y : normal.z;
  if (lead < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  return normal;
}

/**
 * Fit a circle to `points` (three or more, expected roughly planar and
 * roughly circular - see the module doc for what "roughly" is bounded by).
 *
 * Refuses via {@link RadiusFitOutcome}'s `insufficient-points` and `refused`
 * cases rather than throwing: a bad measurement is a value the caller
 * renders as "not circular", not an exception a UI has to catch.
 */
export function fitRadius(picks: readonly Point3[]): RadiusFitOutcome {
  if (picks.length < MIN_RADIUS_POINTS) {
    return { kind: 'insufficient-points', count: picks.length };
  }

  // Every loop below runs over this, never over `picks`, so the click order
  // reaches none of the arithmetic - see {@link canonicalOrder}.
  const points = canonicalOrder(picks);

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
/**
 * `formatLength` defaults to a plain metre spelling so callers with no unit
 * context (tests, the wiring harness) are unchanged. The panel passes
 * `formatDistance(v, unitDisplayOverrides)`, which is what every sibling
 * readout in that panel already uses -- without it a user with a LENGTHUNIT
 * override sees converted distances and metre-only radii side by side.
 */
export function formatRadius(
  outcome: RadiusFitOutcome,
  formatLength: (meters: number) => string = (m) => `${m.toFixed(3)} m`,
): string {
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
      return `R ${formatLength(r)} / D ${formatLength(d)} (${label})`;
    }
  }
}
