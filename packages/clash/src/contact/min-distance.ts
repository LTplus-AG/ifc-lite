/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimum distance between two world-space meshes, with the witness points.
 *
 * Why this is a new traversal rather than a new predicate: the exact
 * triangle-to-triangle minimum distance already exists as `triTriDistance`
 * (`../math/triangle-distance.ts`), and a second copy of that math would be one
 * more thing to keep in step. What did NOT exist anywhere in this package is a
 * traversal that can find the CLOSEST pair.
 *
 * Every other query here is an OVERLAP predicate: `Bvh.queryAABB`,
 * `Bvh.queryPairs` and `queryMeshCross` all prune on AABB intersection, so for
 * two disjoint meshes they return an empty candidate set and there is nothing
 * left to measure. Inflating a clash `clearance` does not substitute either:
 * `testPair` only ever considers triangle pairs already within its margin, so
 * the answer is capped by the margin you guessed rather than found.
 *
 * So this is branch-and-bound over the two BVHs: descend the node pair whose
 * AABB-to-AABB LOWER bound is smallest, and prune any pair whose lower bound is
 * already >= the best real distance found so far. The bound is exact for
 * axis-aligned boxes and never exceeds the true triangle distance, which is
 * what makes the pruning safe: a pruned subtree cannot contain a closer pair.
 */

import { buildMeshBvh, type MeshBvh } from './mesh-bvh.js';
import { triangleAt } from './triangle.js';
import { closestPtPointTriangle, triTriDistance } from '../math/triangle-distance.js';
import { triTriIntersect } from '../math/triangle-intersect.js';
import type { BvhNode } from './bvh.js';
import type { AABB, Mesh, Vec3 } from './types.js';

export interface MeshDistance {
  /** Minimum distance between the two surfaces. 0 when they touch or overlap. */
  readonly distance: number;
  /** Witness point on mesh A. */
  readonly pointA: Vec3;
  /** Witness point on mesh B. */
  readonly pointB: Vec3;
  /** Triangle indices the witness points lie on. */
  readonly triangleA: number;
  readonly triangleB: number;
}

export interface MinDistanceOptions {
  /** Triangles per BVH leaf. Default 8, matching `buildMeshBvh`. */
  readonly leafSize?: number;
  /**
   * Stop as soon as a distance at or below this is found. Use 0 to stop on
   * first contact when only "do they touch" matters; leave unset for the exact
   * distance.
   */
  readonly earlyExitAtOrBelow?: number;
}

/** Squared distance between two AABBs; 0 when they overlap or touch. */
function aabbDistSq(a: AABB, b: AABB): number {
  let total = 0;
  for (let axis = 0; axis < 3; axis++) {
    // Gap on this axis, in whichever direction they are separated. Negative
    // overlap contributes nothing, which is what makes this a LOWER bound.
    const gap = Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
    total += gap * gap;
  }
  return total;
}

/** The tuple `triTriDistance` expects (its Vec3 is mutable). */
function mutable(v: Vec3): [number, number, number] {
  return [v[0], v[1], v[2]];
}

/** A node pair waiting to be explored, with its lower bound on any pair beneath it. */
export interface PairEntry {
  na: BvhNode;
  nb: BvhNode;
  lowerSq: number;
}

/**
 * Binary min-heap over `lowerSq`. Exported for its own tests but deliberately
 * NOT re-exported from `contact/index.ts`, so it stays out of the package's
 * public surface: it is an implementation detail of the traversal, and a
 * hand-rolled sift is precisely the kind of code that needs a direct contract
 * test rather than being covered incidentally.
 *
 * Note that a broken heap order does NOT break the RESULT — the traversal
 * still visits every unpruned pair and still finds the true minimum, just
 * slower. That is why the distance tests cannot catch an inverted comparison
 * here, and why this class is tested on its own terms.
 *
 * Small and local on purpose: this is the only
 * priority queue in the package, and pulling in a dependency (or a generic
 * implementation) for one traversal would be more surface than the ~25 lines
 * it replaces.
 */
export class PairHeap {
  private readonly items: PairEntry[] = [];

  push(entry: PairEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].lowerSq <= items[i].lowerSq) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): PairEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as PairEntry;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < items.length && items[l].lowerSq < items[smallest].lowerSq) smallest = l;
      if (r < items.length && items[r].lowerSq < items[smallest].lowerSq) smallest = r;
      if (smallest === i) break;
      [items[smallest], items[i]] = [items[i], items[smallest]];
      i = smallest;
    }
    return top;
  }
}

interface Best {
  distance: number;
  pointA: Vec3;
  pointB: Vec3;
  triangleA: number;
  triangleB: number;
}

/**
 * Exact minimum distance between two meshes, or `null` when either has no
 * triangles (there is no distance to a mesh that is not there — deliberately
 * distinct from returning 0, which would read as "they touch").
 */
export function minDistanceBetweenMeshes(
  a: Mesh,
  b: Mesh,
  opts: MinDistanceOptions = {},
): MeshDistance | null {
  const bvhA = buildMeshBvh(a, opts.leafSize ?? 8);
  const bvhB = buildMeshBvh(b, opts.leafSize ?? 8);
  return minDistanceBetweenBvhs(bvhA, bvhB, opts);
}

/**
 * Same, for callers that already hold the BVHs. Worth having separately: the
 * BVH is the expensive part, and a measure tool asking about one element
 * against several others should build each mesh's tree once.
 */
export function minDistanceBetweenBvhs(
  a: MeshBvh,
  b: MeshBvh,
  opts: MinDistanceOptions = {},
): MeshDistance | null {
  const rootA = a.bvh.root;
  const rootB = b.bvh.root;
  if (!rootA || !rootB) return null;

  const stopAt = opts.earlyExitAtOrBelow;
  const best: Best = {
    distance: Infinity,
    pointA: [0, 0, 0],
    pointB: [0, 0, 0],
    triangleA: -1,
    triangleB: -1,
  };

  // Frontier of node pairs, popped best-first: the tightest lower bound is
  // explored first, so a good real distance is found early and prunes the most.
  //
  // A min-heap rather than a scan-and-splice over an array. Both are correct,
  // but the frontier grows with the product of the two trees' widths, and a
  // linear pick plus a splice is O(n) each, so the traversal degrades toward
  // quadratic exactly on the large disjoint meshes this query exists for. The
  // heap keeps it O(log n) per pop with the same visit order.
  const frontier = new PairHeap();
  frontier.push({ na: rootA, nb: rootB, lowerSq: aabbDistSq(rootA.bounds, rootB.bounds) });

  for (;;) {
    const next = frontier.pop();
    if (!next) break;
    const { na, nb, lowerSq } = next;

    // The bound is a lower bound on every pair beneath this node pair, so
    // once it reaches the best distance found, nothing here can improve it.
    if (lowerSq >= best.distance * best.distance) continue;

    const leafA = na.items !== undefined;
    const leafB = nb.items !== undefined;

    if (leafA && leafB) {
      for (const ia of na.items ?? []) {
        const triA = triangleAt(a.mesh, Number(a.bvh.items[ia].id));
        const va0 = mutable(triA.v0);
        const va1 = mutable(triA.v1);
        const va2 = mutable(triA.v2);
        for (const ib of nb.items ?? []) {
          const triB = triangleAt(b.mesh, Number(b.bvh.items[ib].id));
          const vb0 = mutable(triB.v0);
          const vb1 = mutable(triB.v1);
          const vb2 = mutable(triB.v2);

          // triTriDistance's own contract (../math/triangle-distance.ts) is
          // "only invoked for non-intersecting pairs" — intersecting ones
          // must be gated separately with triTriIntersect, the same order
          // engine-ts/narrow.ts already uses for its per-pair test. Skipping
          // this gate is exactly the bug this fix closes: an intersecting
          // pair fed to triTriDistance reports a nonzero gap for surfaces
          // that actually overlap.
          if (triTriIntersect(va0, va1, va2, vb0, vb1, vb2)) {
            // 0 is the smallest distance this query can ever report, so once
            // found nothing left in the frontier — pruned or not — can beat
            // it. Return immediately rather than continuing to search.
            //
            // Each `MeshDistance.pointA`/`pointB` is documented as "witness
            // point on mesh A"/"on mesh B" — a point that actually lies ON
            // that triangle. The 6-vertex centroid of BOTH triangles combined
            // (the pre-fix value here) generally lies on neither: it is the
            // mean of six points spread across two different planes, not a
            // point constrained to either surface (PR #2815 review).
            //
            // Two rounds of closest-point projection give a pair of points
            // that DO satisfy that contract exactly, by construction of
            // `closestPtPointTriangle`: project the midpoint of both
            // triangles' centroids onto A, then project THAT point onto B, so
            // `pointB` answers "where does B actually sit relative to A's own
            // witness" rather than an independent, uncorrelated projection.
            // For a genuinely overlapping pair this converges into the
            // overlap region in practice; it is not a claim of the exact
            // deepest-penetration point (computing the true triangle-triangle
            // intersection segment/polygon is a separate, larger fix), but it
            // is always a real point on its own reported triangle, which is
            // the property callers of this witness point can rely on.
            const midCentroid: [number, number, number] = [
              (va0[0] + va1[0] + va2[0] + vb0[0] + vb1[0] + vb2[0]) / 6,
              (va0[1] + va1[1] + va2[1] + vb0[1] + vb1[1] + vb2[1]) / 6,
              (va0[2] + va1[2] + va2[2] + vb0[2] + vb1[2] + vb2[2]) / 6,
            ];
            const pA = closestPtPointTriangle(midCentroid, va0, va1, va2);
            const pB = closestPtPointTriangle(pA, vb0, vb1, vb2);
            return {
              distance: 0,
              pointA: pA,
              pointB: pB,
              triangleA: Number(a.bvh.items[ia].id),
              triangleB: Number(b.bvh.items[ib].id),
            };
          }

          const r = triTriDistance(va0, va1, va2, vb0, vb1, vb2);
          if (r.dist < best.distance) {
            best.distance = r.dist;
            best.pointA = r.pA;
            best.pointB = r.pB;
            best.triangleA = Number(a.bvh.items[ia].id);
            best.triangleB = Number(b.bvh.items[ib].id);
            if (stopAt !== undefined && best.distance <= stopAt) {
              return { ...best };
            }
          }
        }
      }
      continue;
    }

    // Descend the side that is still internal; when both are, split the one
    // with the larger box so the bounds tighten fastest.
    const descendA = leafB || (!leafA && boxExtent(na.bounds) >= boxExtent(nb.bounds));
    const children: Array<{ na: BvhNode; nb: BvhNode }> = [];
    if (descendA && !leafA) {
      if (na.left) children.push({ na: na.left, nb });
      if (na.right) children.push({ na: na.right, nb });
    } else if (!leafB) {
      if (nb.left) children.push({ na, nb: nb.left });
      if (nb.right) children.push({ na, nb: nb.right });
    }
    for (const c of children) {
      const lower = aabbDistSq(c.na.bounds, c.nb.bounds);
      if (lower < best.distance * best.distance) frontier.push({ ...c, lowerSq: lower });
    }
  }

  // Both roots exist, so the mesh has at least one triangle and at least one
  // leaf pair was evaluated: `best` is always populated here. (An earlier
  // version returned null on `triangleA < 0`, which no input could reach —
  // a branch a test cannot exercise is a branch that hides a mistake.)
  return { ...best };
}

/** Longest side of a box, used only to choose which side to split. */
function boxExtent(box: AABB): number {
  return Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
}
