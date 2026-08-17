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
import { isThroughPenetration, obbPenetrationDepth } from './obb.js';

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
  /** The MTD is inflated by the piercing member's own extent; report the
   * AABB estimate instead (see `isThroughPenetration`). */
  through: boolean;
}

export function boxPenetration(small: TriMesh, large: TriMesh): BoxPenetration | null {
  const oa = small.getObb();
  const ob = large.getObb();
  if (!oa || !ob) return null;
  const mtd = obbPenetrationDepth(oa, ob);
  if (mtd == null) return null;
  return { mtd, through: isThroughPenetration(oa, ob) };
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
 * Penetration-depth floor below which a computed overlap cannot be
 * distinguished from float32 rounding noise, scaled to the pair's own
 * coordinate magnitude (not a fixed constant — infra models sit far from the
 * origin, where a fixed epsilon would be far too tight, and small models sit
 * near it, where a fixed epsilon would be far too loose).
 *
 * `rust/clash/src/tri_mesh.rs` ingests geometry from f32 buffers and stores/
 * queries it in f64, so f64 arithmetic cannot recover precision the source
 * data never had: two surfaces authored to be flush round to adjacent f32
 * values, and the resulting "penetration" is bit-noise at the ULP of
 * whichever operand coordinate is largest, not a measured overlap. Extent is
 * the max abs coordinate over both elements' AABBs (world space, matching
 * `near_band_from_extent`'s use of the actual compared coordinates) with a
 * floor of 1.0 so a model near the origin still gets the single-unit ULP,
 * not zero.
 *
 * The floor grows linearly with the pair's distance from the origin — that
 * is the point, since f32 precision itself degrades the same way. The
 * consequence: on a georeferenced model whose elements sit at real map
 * coordinates (hundreds of kilometres out, which real IFC files do), the
 * floor reaches decimetre scale, and a genuine clash below that threshold
 * reclassifies as `touch`. That is not a bug in this function — at those
 * magnitudes f32 genuinely cannot represent a finer distinction, so the
 * "penetration" is not reliably measurable either way — but it means the
 * floor tracks a limitation of the source data, not of clash detection.
 * The fix for a model in that position is ingesting geometry closer to the
 * origin (or in f64), not lowering this floor.
 */
function precisionFloor(elA: ClashElement, elB: ClashElement): number {
  let extent = 1.0;
  for (const b of [elA.bounds, elB.bounds]) {
    for (const v of [b.min, b.max]) {
      for (const c of v) {
        const a = Math.abs(c);
        if (a > extent) extent = a;
      }
    }
  }
  return extent * F32_ULP_SCALE;
}

/**
 * Deepest penetration of `mesh`'s crossing-triangle VERTICES into `other`:
 * the maximum distance-to-surface of `other` over the vertices of the
 * triangles flagged in `crossFlags` (the pairs the narrow phase saw
 * genuinely crossing `other`) that lie inside `other`. Each vertex is
 * visited once (deduped by vertex index, in index order — bit-identical to
 * the Rust `crossing_vertex_penetration`). Returns 0 when no flagged vertex
 * is inside.
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
export function crossingVertexPenetration(mesh: TriMesh, other: TriMesh, crossFlags: Uint8Array): number {
  const seen = new Uint8Array(mesh.vertexCount());
  let depth = 0;
  for (let t = 0; t < mesh.count; t += 1) {
    if (crossFlags[t] === 0) continue;
    for (const vi of mesh.triIndices(t)) {
      if (seen[vi] === 1) continue;
      seen[vi] = 1;
      const v = mesh.vertex(vi);
      if (!other.containsPoint(v)) continue;
      const d = other.distanceToSurface(v);
      if (d > depth) depth = d;
    }
  }
  return depth;
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
 * The pair is `hard` only when the SMALLEST available candidate clears the
 * floor. That is what makes the floor unreachable by depth-source selection:
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
  meshEvidence: number | null,
  elA: ClashElement,
  elB: ClashElement,
  rule: ClashRule,
  point: Vec3,
  bounds: AABB,
): NarrowResult | null {
  let floorDepth = estimate;
  if (box != null && box.mtd < floorDepth) floorDepth = box.mtd;
  if (meshEvidence != null && meshEvidence < floorDepth) floorDepth = meshEvidence;
  if (floorDepth <= precisionFloor(elA, elB)) {
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
