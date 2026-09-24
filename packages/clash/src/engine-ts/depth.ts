/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Depth measurement and the f32-precision floor for the narrow phase
 * (`narrow.ts`). Split out to keep `narrow.ts` under the ~400-line module
 * rule; mirrors `rust/clash/src/depth.rs` structurally so the two kernels
 * stay easy to diff.
 */

import type { AABB, ClashElement, ClashRule, Vec3 } from '../types.js';
import type { TriMesh } from './tri-mesh.js';
import type { NarrowResult } from './narrow.js';
import { isThroughPenetration, obbPenetration } from './obb.js';
import { depthFloor, estimateFloor } from '../math/aabb.js';

/**
 * Exact box-box penetration when BOTH meshes are (within tolerance)
 * rectangular boxes, else `null`. `mtd` is the only source of a `'mesh'`
 * label for a distance that used to come from `TriMesh.maxPenetrationInto` —
 * a nearest-crossing-vertex sampling probe that converges to 0 under
 * retessellation instead of to the true depth (see `obb.ts`, `obb.test.ts`).
 *
 * `through` flags a THROUGH-PENETRATION pair — a thin member piercing clean
 * through the other, e.g. a duct through a wall. There, the minimum-
 * translation-distance `obb.ts` computes is dominated by the piercing
 * member's own extent along the shared axis, not by the material actually
 * crossed (review: #2536, reproduced a 5.5x inflation on exactly this
 * shape), so `depthClashResult` reports the caller's AABB estimate for that
 * shape — matching what `main` did before the box-exact metric existed, and
 * honest about not being a measurement. The MTD is still returned (not
 * discarded here) because the f32 floor must see it: which number gets
 * REPORTED is a separate, later decision from whether the pair is
 * measurable at all (see `depthClashResult`).
 */
export interface BoxPenetration {
  /** Exact box-box minimum-translation depth (Gottschalk 15-axis SAT). */
  mtd: number;
  /** The unit axis `mtd` was measured along (its precision floor's
   * direction, #5405). */
  axis: Vec3;
  /** The MTD is inflated by the piercing member's own extent; report the
   * AABB estimate instead (see `isThroughPenetration`). */
  through: boolean;
}

export function boxPenetration(small: TriMesh, large: TriMesh): BoxPenetration | null {
  const oa = small.getObb();
  const ob = large.getObb();
  if (!oa || !ob) return null;
  const pen = obbPenetration(oa, ob);
  if (pen == null) return null;
  return { mtd: pen.depth, axis: pen.axis, through: isThroughPenetration(oa, ob) };
}

/**
 * f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
 * value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
 * larger magnitudes the ULP only grows. Same `2^-22` term (and reasoning) as
 * `near_band_from_extent` in `rust/geometry/src/kernel/mesh_bridge.rs` — see
 * that function's doc for the derivation; kept here rather than shared
 * because the two live in different language runtimes.
 */
const F32_ULP_SCALE = 1 / 4_194_304; // 2^-22

/**
 * Whether `inner` — AABB-contained in `outer`, with no triangle pair crossing
 * beyond f32 noise — is buried in `outer`'s solid (#5473).
 *
 * With no crossing, each connected shell of `inner` lies entirely on one side
 * of `outer`'s surface up to touching it, so one probe point per shell decides
 * by ray parity — provided the probe is not itself on `outer`'s surface, where
 * parity is a coin flip decided by f32 rounding. The old probe, `inner`'s
 * first vertex, is exactly that point for a flush pair (an element resting
 * against the inside of another's AABB touches it AT its vertices), so a rigid
 * translation re-rolled the verdict.
 *
 * Candidates are `inner`'s vertex centroid (when that lies inside `inner`) and
 * every vertex; a candidate is CLEAR when it is more than
 * {@link PROBE_CLEAR_ULPS} f32 ULPs of its largest coordinate off `outer`'s
 * surface, where its parity is trustworthy.
 * 1. Any clear candidate inside `outer` means its shell is buried: `true`.
 *    Every candidate is checked, because `inner` may be several disconnected
 *    shells and only one of them need be buried (review of #5564); an outside
 *    shell must not end the search.
 * 2. Otherwise any clear candidate is outside, and no shell is clearly
 *    buried: `false`.
 * 3. With no clear candidate at all — every vertex on `outer`'s surface — the
 *    one farthest from it decides. That is what separates an element exactly
 *    filling a notch (its centroid is outside) from a duplicate of part of
 *    `outer` (its centroid is inside).
 *
 * Visit order and strict comparisons keep the pick bit-identical to the Rust
 * `contained_solid_is_buried`.
 */
export function containedSolidIsBuried(inner: TriMesh, outer: TriMesh): boolean {
  if (inner.count === 0) return false;
  const clear = (p: Vec3, d: number): boolean => {
    const m = Math.max(Math.max(Math.max(Math.abs(p[0]), Math.abs(p[1])), Math.abs(p[2])), 1);
    return d > PROBE_CLEAR_ULPS * F32_ULP_SCALE * m;
  };
  const candidates: Vec3[] = [];
  const c = inner.vertexCentroid();
  if (inner.containsPoint(c)) candidates.push(c);
  const n = inner.vertexCount();
  for (let i = 0; i < n; i += 1) candidates.push(inner.vertex(i));
  // 1. A clearly buried shell. Parity first: it is the cheaper query, and
  //    only candidates it places inside need their distance.
  if (candidates.some((p) => outer.containsPoint(p) && clear(p, outer.distanceToSurface(p)))) return true;
  // 2./3. No shell is clearly buried.
  let probe: Vec3 | null = null;
  let farthest = -Infinity;
  for (const p of candidates) {
    const d = outer.distanceToSurface(p);
    if (clear(p, d)) return false;
    if (d > farthest) {
      farthest = d;
      probe = p;
    }
  }
  return probe !== null && outer.containsPoint(probe);
}

/**
 * How far off `outer`'s surface a candidate must be for
 * `containedSolidIsBuried` to trust its ray parity, in f32 ULPs of its largest
 * coordinate. Generous on purpose: rounding moves a point on the surface by a
 * few ULPs, and a vertex any closer is treated as touching, which only defers
 * the verdict to a farther candidate.
 */
const PROBE_CLEAR_ULPS = 64;

/** A crossing vertex's penetration into the other solid, with the unit
 *  direction it was measured along (from the other's surface to the vertex),
 *  which is what its precision floor is projected onto (#5405). */
export interface VertexPenetration {
  depth: number;
  axis: Vec3;
}

/**
 * Deepest penetration of `mesh`'s crossing-triangle VERTICES into `other`:
 * the vertex of the triangles flagged in `crossFlags` (the pairs the narrow
 * phase saw genuinely crossing `other`) that lies inside `other` farthest
 * from its surface. Each vertex is visited once (deduped by vertex index, in
 * index order, strict `>` — bit-identical to the Rust
 * `crossing_vertex_penetration`). `null` when no flagged vertex is strictly
 * inside.
 *
 * This is NOT a depth metric and must never be reported as one — it is the
 * sampling probe PR #2536 was held over (`maxPenetrationInto`): its value is
 * an O(edge length) artifact that converges to 0 under retessellation
 * instead of to the true depth. It survives with exactly one client: the
 * f32 noise-floor gate for a CONTAINED pair (`depthClashResult`), where the
 * question is not "how deep?" but "is any mesh-level penetration measurably
 * above the floor at all?" — sub-floor here means every crossing vertex sits
 * within f32 rounding noise of the other surface, i.e. surfaces authored
 * flush, which no amount of retessellation turns into a real overlap. For
 * that yes/no question the probe's underestimation is harmless:
 * underestimating can only keep a pair BELOW the floor, and the floor is
 * the very thing being tested.
 */
export function crossingVertexPenetration(mesh: TriMesh, other: TriMesh, crossFlags: Uint8Array): VertexPenetration | null {
  const seen = new Uint8Array(mesh.vertexCount());
  let deepest: VertexPenetration | null = null;
  for (let t = 0; t < mesh.count; t += 1) {
    if (crossFlags[t] === 0) continue;
    for (const vi of mesh.triIndices(t)) {
      if (seen[vi] === 1) continue;
      seen[vi] = 1;
      const v = mesh.vertex(vi);
      if (!other.containsPoint(v)) continue;
      const [d, q] = other.closestOnSurface(v);
      if (d > (deepest?.depth ?? 0)) {
        deepest = { depth: d, axis: [(v[0] - q[0]) / d, (v[1] - q[1]) / d, (v[2] - q[2]) / d] };
      }
    }
  }
  return deepest;
}

/**
 * Turns the candidate penetration depths into the final `(status,
 * distanceKind, distance)` triple. This is the ONLY place in the narrow
 * phase allowed to build a `'mesh'`- or `'estimate'`-labelled `hard` result
 * off a depth number — every branch in `narrow.ts` that can label a result
 * `'mesh'` off `boxPenetration` (or its AABB-estimate fallback) MUST route
 * through here rather than building the `NarrowResult` literal itself. That
 * is what makes the f32 floor apply to all of them, and what enforces its
 * precedence.
 *
 * THE FLOOR WINS (#2536 rebase decision): a pair below the f32 noise floor
 * is `touch` regardless of how its depth was derived — at that magnitude the
 * number is not measurable either way — so the floor is tested against EVERY
 * candidate depth the pair has, not against whichever one the estimate-vs-
 * mesh selection would report. Three candidates exist:
 *
 * - the AABB `estimate` (always present);
 * - the box MTD, when both elements are certified boxes (`box`);
 * - the crossing-vertex penetration, for a CONTAINED pair with a crossing
 *   vertex inside the other solid (`meshEvidence`) — evidence for this gate
 *   only, never a reported depth (see `crossingVertexPenetration`).
 *
 * Each candidate is tested against the floor OF ITS OWN DIRECTION — the
 * pair's per-axis f32 noise projected onto the direction that candidate was
 * measured along (`depthFloor`, `estimateFloor`; #5405). A single floor from
 * the max coordinate over all axes handed a Z-direction depth the noise of
 * an X coordinate 10 km out: a genuine 2 mm overlap read as `touch` there and
 * `hard` at the origin, and near the origin the X extent pinned the threshold
 * for contacts that have no X component at all.
 *
 * The pair is `hard` only when EVERY available candidate clears its floor.
 * That is what makes the floor unreachable by depth-source selection:
 * a sub-floor box MTD cannot be promoted by the through-penetration guard
 * swapping in a larger AABB estimate; a sub-floor crossing-vertex
 * penetration on a contained pair (surfaces authored flush — the eight
 * Infra-Bridge pairs that moved #2594's 50-hard-clash pin to 58 when this
 * PR's depth rework replaced their noise-scale mesh depth with the
 * fabricated 4 m AABB estimate) cannot be promoted by that estimate; and a
 * sub-floor AABB estimate cannot be promoted by a larger MTD (a through-
 * penetration far from the origin, where the MTD is inflated by the
 * piercing member's own extent). Only a pair already above the floor
 * reaches the selection below, which then merely picks WHICH above-floor
 * reportable number is used and how it is labelled — so a `hard` result's
 * distance clears the floor by construction, whichever quantity it came
 * from.
 */
export function depthClashResult(
  box: BoxPenetration | null,
  estimate: number,
  meshEvidence: VertexPenetration | null,
  elA: ClashElement,
  elB: ClashElement,
  rule: ClashRule,
  point: Vec3,
  bounds: AABB,
): NarrowResult | null {
  // `||` in the same order as the Rust kernel, each comparison `<=` so a NaN
  // candidate never counts as below its floor, on either side.
  const belowFloor =
    estimate <= estimateFloor(elA.bounds, elB.bounds) ||
    (box != null && box.mtd <= depthFloor(box.axis, elA.bounds, elB.bounds)) ||
    (meshEvidence != null && meshEvidence.depth <= depthFloor(meshEvidence.axis, elA.bounds, elB.bounds));
  if (belowFloor) {
    if (!rule.reportTouch) return null;
    // distance is exactly 0 here (the classification, not a measurement, is
    // what changed), so `mesh` — consistent with the other exact-distance
    // `touch` result.
    return { status: 'touch', distance: 0, distanceKind: 'mesh', point, bounds };
  }
  // Estimate-vs-mesh selection, reachable only above the floor: the box MTD
  // is certified (`mesh`) unless the pair is a through-penetration, where
  // the AABB estimate is the honest number (see `boxPenetration`).
  const measured = box != null && !box.through;
  return {
    status: 'hard',
    distance: -(measured ? box.mtd : estimate),
    distanceKind: measured ? 'mesh' : 'estimate',
    point,
    bounds,
  };
}
