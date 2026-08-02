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
  // Dedup — BVHs partition the triangle set, so no true duplicates, but
  // belt-and-braces:
  const seen = new Set<string>();
  const deduped: Array<readonly [number, number]> = [];
  for (const p of out) {
    const key = `${p[0]}|${p[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  return deduped;
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
