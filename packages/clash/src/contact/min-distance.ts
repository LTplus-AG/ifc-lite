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
import { triTriDistance } from '../math/triangle-distance.js';
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

  // Explicit stack of node pairs with their lower bound, processed
  // best-first: a good bound found early prunes the most.
  const stack: Array<{ na: BvhNode; nb: BvhNode; lowerSq: number }> = [
    { na: rootA, nb: rootB, lowerSq: aabbDistSq(rootA.bounds, rootB.bounds) },
  ];

  while (stack.length > 0) {
    // Pop the most promising pair rather than the last pushed.
    let pick = 0;
    for (let i = 1; i < stack.length; i++) {
      if (stack[i].lowerSq < stack[pick].lowerSq) pick = i;
    }
    const { na, nb, lowerSq } = stack.splice(pick, 1)[0];

    // The bound is a lower bound on every pair beneath this node pair, so
    // once it reaches the best distance found, nothing here can improve it.
    if (lowerSq >= best.distance * best.distance) continue;

    const leafA = na.items !== undefined;
    const leafB = nb.items !== undefined;

    if (leafA && leafB) {
      for (const ia of na.items ?? []) {
        const triA = triangleAt(a.mesh, Number(a.bvh.items[ia].id));
        for (const ib of nb.items ?? []) {
          const triB = triangleAt(b.mesh, Number(b.bvh.items[ib].id));
          const r = triTriDistance(
            mutable(triA.v0), mutable(triA.v1), mutable(triA.v2),
            mutable(triB.v0), mutable(triB.v1), mutable(triB.v2),
          );
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
      if (lower < best.distance * best.distance) stack.push({ ...c, lowerSq: lower });
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
