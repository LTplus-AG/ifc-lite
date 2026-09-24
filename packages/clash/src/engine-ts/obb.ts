/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact penetration depth for the one shape family it can be exact for:
 * rectangular boxes. `maxPenetrationInto` (removed) measured the distance from
 * the nearest crossing-triangle VERTEX to the other surface — an O(edge
 * length) sampling artifact that converges to 0 as a mesh is retessellated,
 * the opposite of what a depth metric should do (see the analytic-oracle
 * fixtures in `obb.test.ts`).
 *
 * This module instead detects when both meshes ARE (within tolerance)
 * axis-independent rectangular boxes and, only then, reports the minimum
 * translation distance along a separating axis — the classical two-OBB
 * penetration depth, which for boxes is provably exact and, because it is
 * derived from the box's face-plane geometry rather than its triangulation,
 * provably unchanged by retessellation. When either mesh is not confirmed to
 * be a box, the caller falls back to the AABB estimate (never a wrong 'mesh'
 * label) — a smaller true thing rather than a large wrong one.
 */

import type { Vec3 } from '../types.js';
import { cross, dot } from '../math/vec3.js';

/** Tolerance for normal-direction dedup and offset-plane clustering. Same
 * literal in the Rust kernel — see `rust/clash/src/obb.rs`. */
export const OBB_EPS = 1e-6;

export interface Obb {
  center: Vec3;
  /** Three mutually orthogonal unit axes. */
  axes: [Vec3, Vec3, Vec3];
  /** Half-extent along each axis, matching `axes` by index. */
  half: [number, number, number];
}

/** Minimal structural view of `TriMesh` this module needs — avoids a
 * circular import between `obb.ts` and `tri-mesh.ts`. */
export interface MeshLike {
  readonly count: number;
  tri(t: number): [Vec3, Vec3, Vec3];
}

/**
 * Bound, in f64 ulps, on the absolute error of one component of the cross
 * product of two UNIT vectors (each component is a product-difference of
 * magnitude-<=1 terms: ~2 ulps), with headroom for the normalisation and the
 * per-projection dot rounding it feeds. Shared by the axis noise bound in
 * {@link obbPenetration}; same literal in the Rust kernel.
 */
export const AXIS_NOISE_ULPS = 8;

/** An OBB-OBB minimum translation depth and the UNIT axis it was measured
 *  along: the depth's precision floor is the pair's f32 noise projected onto
 *  that axis (#5405). Mirrors the Rust `ObbPenetration`. */
export interface ObbPenetration {
  depth: number;
  axis: Vec3;
}

/**
 * Exact penetration depth between two oriented boxes: the minimum overlap
 * over the 15 canonical OBB-OBB separating-axis candidates (each box's 3 face
 * normals, plus the 9 pairwise cross products of one box's axes with the
 * other's) — the standard result (Gottschalk, "Collision Queries using
 * Oriented Bounding Boxes") that the minimum-translation-distance axis for two
 * boxes is always among these 15.
 *
 * Cross-product candidates are conditioned by their length: both operands are
 * unit axes, so `|L| = sin(angle between them)`, and normalising amplifies
 * the ~ulp-level absolute error of the cross product into a direction error
 * of up to `AXIS_NOISE_ULPS * EPS / |L|` radians. Each candidate's verdict
 * therefore carries a SCALE-RELATIVE noise bound (see `testAxis`), and a
 * verdict inside its own noise band is never trusted to separate, and
 * contributes a depth candidate of zero rather than being dropped from the
 * minimum (#5355) (review: #2536; the same
 * tolerance-from-the-wrong-quantity class as #2598/#2600/#2529 — an earlier
 * ABSOLUTE `len > 1e-6` guard here both divided by lengths whose noise
 * dwarfs a thin overlap at large operand scale, and hard-dropped axes that
 * were fine: for kilometre-scale near-parallel beams the dropped common
 * normal IS the
 * minimum-translation axis, and the min over the remaining axes over-reported
 * a 0.02 m edge contact as a certified 0.45 m depth — see `obb.test.ts`).
 *
 * Returns `null` if any candidate axis reports, beyond its noise band, zero
 * or negative overlap — the boxes would be separated along it, contradicting
 * the caller's own crossing test — so a numerical edge case degrades to
 * `null` (caller falls back to the AABB estimate) rather than reporting a
 * wrong depth.
 */
export function obbPenetration(a: Obb, b: Obb): ObbPenetration | null {
  const T: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  // Operand scale for the per-axis noise bound: the sum of BOTH boxes' three
  // half-extents plus the center offset's components. A direction error of
  // `e` radians in a candidate axis perturbs each projection term by up to
  // (that term's extent) * e, so the summed extents bound the total overlap
  // error at `extentSum * e`. Deliberately NOT the projected radii rA/rB of
  // the axis under test: an extent nearly PERPENDICULAR to the axis projects
  // to ~0 yet contributes its full magnitude of noise (a 1 km beam projects
  // nothing onto its cross-section normal but sways that normal's projection
  // by up to 1 km * e), the same the-world-magnitude-is-the-wrong-quantity
  // trap as the local-extent tolerance in
  // `packages/drawing-2d/src/section-cutter.ts` (#2622), with the roles
  // reversed: here the SUMMED extents are the right quantity and the
  // projected ones are the trap.
  const extentSum =
    a.half[0] + a.half[1] + a.half[2] +
    b.half[0] + b.half[1] + b.half[2] +
    Math.abs(T[0]) + Math.abs(T[1]) + Math.abs(T[2]);
  let depth = Infinity;
  let depthAxis: Vec3 = [0, 0, 0];

  function testAxis(L: Vec3): boolean {
    const len = Math.sqrt(dot(L, L));
    // Exactly parallel axes: the cross product is zero and the candidate
    // direction is spanned by the remaining axes (for boxes with a parallel
    // axis pair the face axes alone realise the minimum — the classical SAT
    // redundancy result), so skipping is exact, and it avoids 0/0 below.
    if (!(len > 0)) return true;
    const u: Vec3 = [L[0] / len, L[1] / len, L[2] / len];
    const rA =
      a.half[0] * Math.abs(dot(a.axes[0], u)) +
      a.half[1] * Math.abs(dot(a.axes[1], u)) +
      a.half[2] * Math.abs(dot(a.axes[2], u));
    const rB =
      b.half[0] * Math.abs(dot(b.axes[0], u)) +
      b.half[1] * Math.abs(dot(b.axes[1], u)) +
      b.half[2] * Math.abs(dot(b.axes[2], u));
    const dist = Math.abs(dot(T, u));
    const overlap = rA + rB - dist;
    // Scale-relative conditioning guard, replacing an absolute `len > 1e-6`
    // (review: #2536). `u`'s direction is uncertain by up to
    // `AXIS_NOISE_ULPS * EPS / len` radians (cancellation shrinks `|L|` to
    // sin(angle) but leaves the cross product's ~ulp absolute error intact),
    // so `overlap` is uncertain by up to `extentSum` times that. A verdict
    // inside the band may not SEPARATE: in a separating-axis test, declining
    // to separate can only fail to find a separation, never invent one, so
    // the boolean result stays conservative. Do not "harden" this into
    // returning false: that would turn unresolvable noise into a fabricated
    // separation. Verdicts OUTSIDE the band are kept whatever `len` is —
    // their own magnitude proves the noise did not decide them.
    //
    // It DOES still contribute a depth candidate, of zero (#5355). The depth
    // is a MINIMUM over candidates, so an axis whose overlap is
    // indistinguishable from zero is the smallest candidate present;
    // dropping it hands the minimum to the next-smallest axis, which for two
    // boxes in flush face contact is a FACE DIMENSION of one of them. #2536
    // fixed WHICH axes fall in the band (an absolute `len > 1e-6` dropped
    // axes that were fine, over-reporting a 0.02 m edge contact as 0.45 m);
    // the remaining half was what dropping does to the minimum, which still
    // reported 0.85 m for a 0.05 m curtain-wall panel lying flush against a
    // mullion.
    const noise = extentSum * ((AXIS_NOISE_ULPS * Number.EPSILON) / len);
    if (Math.abs(overlap) <= noise) {
      if (depth > 0) {
        depth = 0;
        depthAxis = u;
      }
      return true;
    }
    if (overlap <= 0) return false;
    if (overlap < depth) {
      depth = overlap;
      depthAxis = u;
    }
    return true;
  }

  for (let i = 0; i < 3; i += 1) if (!testAxis(a.axes[i])) return null;
  for (let i = 0; i < 3; i += 1) if (!testAxis(b.axes[i])) return null;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (!testAxis(cross(a.axes[i], b.axes[j]))) return null;
    }
  }
  return depth === Infinity ? null : { depth, axis: depthAxis };
}

/**
 * Projected radius of `o` onto unit axis `u`: half the length of `o`'s
 * shadow on `u`. The same per-axis projection {@link obbPenetration}'s
 * `testAxis` computes for the 15-candidate SAT — factored out here so the
 * through-penetration containment test below can reuse it for ANY axis, not
 * only one drawn from a shared a/b frame.
 */
function projRadius(o: Obb, u: Vec3): number {
  return (
    o.half[0] * Math.abs(dot(o.axes[0], u)) +
    o.half[1] * Math.abs(dot(o.axes[1], u)) +
    o.half[2] * Math.abs(dot(o.axes[2], u))
  );
}

/**
 * Whether `p`'s own axes reveal a through-penetration of `p` piercing `q` —
 * `p`'s footprint, in the plane perpendicular to one of `p`'s OWN axes, fits
 * inside `q`'s cross-section there (edges included), while along that axis `p`
 * extends beyond `q` and out the far side. `q`'s extent along any of `p`'s
 * axes is `projRadius(q, axis)` — the general SAT projection, valid whether
 * or not `q`'s own axes align with `p`'s — so this needs no shared frame.
 */
function piercesAlong(p: Obb, q: Obb, centerDelta: Vec3): boolean {
  const margin = (h: number) => OBB_EPS * Math.max(1, h);
  for (let k = 0; k < 3; k += 1) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    const axisK = p.axes[k];
    const axisI = p.axes[i];
    const axisJ = p.axes[j];
    const offK = dot(centerDelta, axisK);
    const offI = dot(centerDelta, axisI);
    const offJ = dot(centerDelta, axisJ);
    const rQk = projRadius(q, axisK);
    const rQi = projRadius(q, axisI);
    const rQj = projRadius(q, axisJ);
    // P's footprint on the other two axes fits inside Q's, edges INCLUDED —
    // the tolerance opens the test up rather than tightening it. An earlier
    // version demanded a real margin (`rQi - margin(rQi)`) so that two slabs
    // sharing a footprint would not read as a piercing member; but what
    // actually disqualifies that pair is the `k`-axis test below, and the
    // strict form instead rejected the commonest configuration in any
    // building — two walls crossing at an X-junction, where each pierces the
    // other clean through in thickness but the shared height TIES. That pair
    // reported the full 3 m wall height as a certified `'mesh'` penetration
    // (review: #2536 — `main` reported the honest 0.200 m). The strict form
    // was also discontinuous: tilting one wall by 1e-6 rad flipped it back to
    // `true`, so a hair of rotation moved the reported depth from 3.000 m to
    // 0.200 m.
    const pInsideQ =
      Math.abs(offI) + p.half[i] <= rQi + margin(rQi) && Math.abs(offJ) + p.half[j] <= rQj + margin(rQj);
    // "Exits the far side" along k means P's interval extends past Q's on
    // BOTH ends, not merely that P's half-extent is the bigger number — a
    // footing embedded 75 mm into a slab from ABOVE is longer than the slab
    // along Z (it does not fit inside it) but only pokes out the TOP, not
    // the bottom, so it is a partial overlap, not a through-penetration.
    // Requiring `p.half[k] > rQk + |offK|` is exactly "P's interval strictly
    // contains Q's interval on axis k", i.e. P pokes out past Q on both sides.
    if (pInsideQ && p.half[k] > rQk + Math.abs(offK) + margin(rQk)) return true;
  }
  return false;
}

/**
 * Whether `a` and `b` are in a THROUGH-PENETRATION configuration: one box's
 * cross-section, in the plane perpendicular to one of ITS OWN axes, is fully
 * inside the other's footprint there, while along that axis it extends
 * beyond the other and out the far side — a thin member piercing clean
 * through a wall/slab, not a partial overlap. The relation is checked BOTH
 * ways, so it also holds for the MUTUAL case: two walls crossing at an
 * X-junction, each piercing the other clean through in thickness.
 *
 * This matters because {@link obbPenetration} reports the minimum
 * TRANSLATION distance to separate the pair, which for this shape is
 * dominated by the piercing member's own extent along the piercing axis, not
 * by how much material it actually crossed (review: #2536 — a 2 m duct
 * through a 200 mm wall reported 1.1 m, not 0.2 m). Detecting the shape lets
 * the caller decline to certify that number as a measured depth.
 *
 * Tests containment against EACH box's own axes independently (via
 * {@link piercesAlong}'s general per-axis projection, the same projection
 * {@link obbPenetration} already computes for its 15 SAT candidates) —
 * unlike an earlier version restricted to a frame shared by both boxes'
 * axes up to sign, this also catches a member piercing through at a generic
 * relative rotation (e.g. a duct crossing a wall at 15 degrees, review:
 * #2536 follow-up — the earlier version measured -1.1177 there, `'mesh'`-
 * labelled, against a true ~0.207 m).
 */
export function isThroughPenetration(a: Obb, b: Obb): boolean {
  const d: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  const negD: Vec3 = [-d[0], -d[1], -d[2]];
  // A piercing B along one of A's own axes, or B piercing A along one of B's.
  return piercesAlong(a, b, d) || piercesAlong(b, a, negD);
}
