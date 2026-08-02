/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EMPTY_AABB, center, intersects, longestAxis, unionAabb } from "./aabb.js";
import type { AABB, MeshBounds } from "./types.js";

/**
 * Median-split BVH with two query primitives:
 *   - queryAABB(q): items overlapping `q`
 *   - queryPairs(eps?): all unordered pairs whose (optionally inflated) AABBs overlap
 *
 * Build cost: O(n log n). queryPairs descends both subtrees simultaneously,
 * pruning on AABB intersection — true O(n log n) self-pair enumeration rather
 * than O(n^2) per-element queries.
 */

export interface BvhNode {
  readonly bounds: AABB;
  readonly left?: BvhNode;
  readonly right?: BvhNode;
  /** Indices into the original `items` array; present only on leaves. */
  readonly items?: readonly number[];
}

export interface BvhOptions {
  /** Maximum items per leaf; lower = deeper tree, higher = faster build. */
  readonly leafSize?: number;
}

export class Bvh {
  readonly root: BvhNode | null;
  readonly items: readonly MeshBounds[];

  private constructor(root: BvhNode | null, items: readonly MeshBounds[]) {
    this.root = root;
    this.items = items;
  }

  /** Build a BVH from a list of bounded items. Median-split along the longest axis. */
  static build(items: readonly MeshBounds[], opts: BvhOptions = {}): Bvh {
    if (items.length === 0) return new Bvh(null, items);
    const leafSize = Math.max(1, opts.leafSize ?? 4);
    const indices = items.map((_, i) => i);
    const root = buildNode(items, indices, leafSize);
    return new Bvh(root, items);
  }

  /** Return ids of items whose AABB intersects `q`. Order is depth-first, stable. */
  queryAABB(q: AABB): string[] {
    if (!this.root) return [];
    const out: string[] = [];
    queryAabbNode(this.root, q, this.items, out);
    return out;
  }

  /**
   * Return all unordered pairs `(idA, idB)` with idA < idB (lex) whose AABBs
   * (optionally inflated by `epsilon` on all sides) overlap. Pair order is
   * deterministic given input order.
   */
  queryPairs(epsilon = 0): IdPair[] {
    if (!this.root) return [];
    const out: IdPair[] = [];
    selfPair(this.root, this.items, epsilon, out);
    // Stable canonicalisation — the emission loops already guarantee no dupes,
    // but we sort both within each pair and across the pair array so the
    // output is insensitive to tree construction order (just input order).
    for (let i = 0; i < out.length; i++) {
      const p = out[i] as [string, string];
      if (p[0] > p[1]) out[i] = [p[1], p[0]];
    }
    out.sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
    return out;
  }
}

type IdPair = readonly [string, string];

function buildNode(items: readonly MeshBounds[], indices: number[], leafSize: number): BvhNode {
  if (indices.length === 0) {
    return { bounds: EMPTY_AABB, items: [] };
  }
  const bounds = indices.reduce<AABB>(
    (acc, idx) => unionAabb(acc, (items[idx] as MeshBounds).aabb),
    EMPTY_AABB,
  );
  if (indices.length <= leafSize) {
    return { bounds, items: indices.slice() };
  }
  const axis = longestAxis(bounds);
  // Sort indices by centre along longest axis, then split at median.
  indices.sort((ia, ib) => {
    const ca = center((items[ia] as MeshBounds).aabb)[axis];
    const cb = center((items[ib] as MeshBounds).aabb)[axis];
    return ca - cb;
  });
  const mid = indices.length >> 1;
  const leftIdx = indices.slice(0, mid);
  const rightIdx = indices.slice(mid);
  return {
    bounds,
    left: buildNode(items, leftIdx, leafSize),
    right: buildNode(items, rightIdx, leafSize),
  };
}

function queryAabbNode(node: BvhNode, q: AABB, items: readonly MeshBounds[], out: string[]): void {
  if (!intersects(node.bounds, q)) return;
  if (node.items) {
    for (const i of node.items) {
      const it = items[i] as MeshBounds;
      if (intersects(it.aabb, q)) out.push(it.id);
    }
    return;
  }
  if (node.left) queryAabbNode(node.left, q, items, out);
  if (node.right) queryAabbNode(node.right, q, items, out);
}

/** Dual-traversal self-pair emission. */
function selfPair(node: BvhNode, items: readonly MeshBounds[], eps: number, out: IdPair[]): void {
  if (node.items) {
    emitLeafPairs(node.items, items, eps, out);
    return;
  }
  if (node.left) selfPair(node.left, items, eps, out);
  if (node.right) selfPair(node.right, items, eps, out);
  if (node.left && node.right) crossPair(node.left, node.right, items, eps, out);
}

function crossPair(
  a: BvhNode,
  b: BvhNode,
  items: readonly MeshBounds[],
  eps: number,
  out: IdPair[],
): void {
  if (!boundsOverlapInflated(a.bounds, b.bounds, eps)) return;
  if (a.items && b.items) {
    emitLeafCross(a.items, b.items, items, eps, out);
    return;
  }
  // Descend the larger side first to keep recursion depth bounded.
  if (a.items) {
    if (b.left) crossPair(a, b.left, items, eps, out);
    if (b.right) crossPair(a, b.right, items, eps, out);
    return;
  }
  if (b.items) {
    if (a.left) crossPair(a.left, b, items, eps, out);
    if (a.right) crossPair(a.right, b, items, eps, out);
    return;
  }
  if (a.left) {
    if (b.left) crossPair(a.left, b.left, items, eps, out);
    if (b.right) crossPair(a.left, b.right, items, eps, out);
  }
  if (a.right) {
    if (b.left) crossPair(a.right, b.left, items, eps, out);
    if (b.right) crossPair(a.right, b.right, items, eps, out);
  }
}

function emitLeafPairs(
  leaf: readonly number[],
  items: readonly MeshBounds[],
  eps: number,
  out: IdPair[],
): void {
  for (let i = 0; i < leaf.length; i++) {
    const ia = leaf[i] as number;
    const a = items[ia] as MeshBounds;
    for (let j = i + 1; j < leaf.length; j++) {
      const ib = leaf[j] as number;
      const b = items[ib] as MeshBounds;
      if (boundsOverlapInflated(a.aabb, b.aabb, eps)) out.push([a.id, b.id]);
    }
  }
}

function emitLeafCross(
  aLeaf: readonly number[],
  bLeaf: readonly number[],
  items: readonly MeshBounds[],
  eps: number,
  out: IdPair[],
): void {
  for (const ia of aLeaf) {
    const a = items[ia] as MeshBounds;
    for (const ib of bLeaf) {
      const b = items[ib] as MeshBounds;
      if (a.id === b.id) continue;
      if (boundsOverlapInflated(a.aabb, b.aabb, eps)) out.push([a.id, b.id]);
    }
  }
}

function boundsOverlapInflated(a: AABB, b: AABB, eps: number): boolean {
  if (eps === 0) return intersects(a, b);
  return (
    a.min[0] - eps <= b.max[0] + eps &&
    a.max[0] + eps >= b.min[0] - eps &&
    a.min[1] - eps <= b.max[1] + eps &&
    a.max[1] + eps >= b.min[1] - eps &&
    a.min[2] - eps <= b.max[2] + eps &&
    a.max[2] + eps >= b.min[2] - eps
  );
}
