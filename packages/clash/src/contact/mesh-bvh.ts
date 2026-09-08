/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Bvh } from "./bvh.js";
import { triangleAabb, triangleAt, triangleCount } from "./triangle.js";
import type { Mesh, MeshBounds } from "./types.js";

/**
 * A BVH over a mesh's triangles. Item ids are stringified triangle indices.
 * Cross-traversal between two MeshBvh yields candidate triangle-pair indices.
 */
export interface MeshBvh {
  readonly mesh: Mesh;
  readonly bvh: Bvh;
}

export function buildMeshBvh(mesh: Mesh, leafSize = 8): MeshBvh {
  const n = triangleCount(mesh);
  const items: MeshBounds[] = new Array(n);
  for (let i = 0; i < n; i++) {
    items[i] = { id: String(i), aabb: triangleAabb(triangleAt(mesh, i)) };
  }
  return { mesh, bvh: Bvh.build(items, { leafSize }) };
}

/**
 * Cross-query two MeshBvh instances. Returns candidate triangle-index pairs
 * `(iA, iB)` where iA is in `a.mesh` and iB is in `b.mesh`, whose AABBs
 * (inflated by `epsilon`) overlap.
 *
 * Pairs are not canonicalised — both meshes are distinct inputs, so order
 * is preserved (A first, B second).
 */
export function queryMeshCross(
  a: MeshBvh,
  b: MeshBvh,
  epsilon = 0,
): Array<readonly [number, number]> {
  if (!a.bvh.root || !b.bvh.root) return [];
  const out: Array<readonly [number, number]> = [];
  crossNode(a.bvh, b.bvh, a.bvh.root, b.bvh.root, epsilon, out);
  // No dedup pass: the traversal cannot emit a pair twice, so one would be
  // pure cost. `buildNode` (bvh.ts) splits a node's indices into disjoint,
  // covering halves and a leaf keeps exactly its own slice, so every
  // triangle lives in exactly ONE leaf — leaves PARTITION the triangle set.
  // And `crossNode` reaches a node pair (u, w) by one route only: it
  // descends both sides together while both are internal, and only the
  // internal side once the other is a leaf, so with one parent per node the
  // path from (rootA, rootB) is forced. One visit per leaf pair, therefore
  // at most one emission per (iA, iB).
  //
  // This previously ran a `Set<`${iA}|${iB}`>` over `out` as "belt and
  // braces". It deduped nothing (see mesh-bvh.test.ts, which pins the
  // emitted list against brute force across leaf sizes and topologies)
  // while allocating one key string and one Set entry per emitted pair —
  // O(triA * triB) in the worst case, for a SINGLE element pair, uncapped.
  // `Set` shares V8's hard 2^24-entry ceiling, past which insertion throws
  // `RangeError`; 4096 * 4096 = 2^24, so two ~4k-triangle elements whose
  // AABB filter passes nearly everything (dense interpenetrating solids)
  // sit exactly on it. Below that it was simply wasted allocation on the
  // hottest inner loop of contact clustering.
  return out;
}

function crossNode(
  aTree: Bvh,
  bTree: Bvh,
  aNode: NonNullable<Bvh["root"]>,
  bNode: NonNullable<Bvh["root"]>,
  eps: number,
  out: Array<readonly [number, number]>,
): void {
  if (!boundsOverlap(aNode.bounds, bNode.bounds, eps)) return;
  const aLeaf = aNode.items;
  const bLeaf = bNode.items;
  if (aLeaf && bLeaf) {
    for (const ia of aLeaf) {
      const aItem = aTree.items[ia];
      if (!aItem) continue;
      for (const ib of bLeaf) {
        const bItem = bTree.items[ib];
        if (!bItem) continue;
        if (boundsOverlap(aItem.aabb, bItem.aabb, eps)) {
          out.push([Number(aItem.id), Number(bItem.id)]);
        }
      }
    }
    return;
  }
  if (aLeaf) {
    if (bNode.left) crossNode(aTree, bTree, aNode, bNode.left, eps, out);
    if (bNode.right) crossNode(aTree, bTree, aNode, bNode.right, eps, out);
    return;
  }
  if (bLeaf) {
    if (aNode.left) crossNode(aTree, bTree, aNode.left, bNode, eps, out);
    if (aNode.right) crossNode(aTree, bTree, aNode.right, bNode, eps, out);
    return;
  }
  if (aNode.left) {
    if (bNode.left) crossNode(aTree, bTree, aNode.left, bNode.left, eps, out);
    if (bNode.right) crossNode(aTree, bTree, aNode.left, bNode.right, eps, out);
  }
  if (aNode.right) {
    if (bNode.left) crossNode(aTree, bTree, aNode.right, bNode.left, eps, out);
    if (bNode.right) crossNode(aTree, bTree, aNode.right, bNode.right, eps, out);
  }
}

function boundsOverlap(
  a: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  b: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  eps: number,
): boolean {
  return (
    a.min[0] - eps <= b.max[0] + eps &&
    a.max[0] + eps >= b.min[0] - eps &&
    a.min[1] - eps <= b.max[1] + eps &&
    a.max[1] + eps >= b.min[1] - eps &&
    a.min[2] - eps <= b.max[2] + eps &&
    a.max[2] + eps >= b.min[2] - eps
  );
}
