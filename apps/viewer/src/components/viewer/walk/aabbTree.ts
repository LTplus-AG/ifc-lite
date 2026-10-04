/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A flat, typed-array bounding-volume tree over axis-aligned boxes.
 *
 * Walk-mode collision runs one box query per physics substep at 120 Hz, over
 * models with hundreds of thousands of entities and single meshes of millions
 * of triangles (terrain, merged facades). An object-per-node tree costs a
 * pointer chase and an allocation per node at that scale, so the tree here is
 * three typed arrays and a reusable traversal stack: the build allocates once,
 * a query allocates nothing.
 *
 * The same tree indexes both levels: entities by their world AABB, and the
 * triangles of one large mesh by their local-frame boxes.
 */

/** Items per leaf. Small leaves keep the exact per-triangle test count low. */
const LEAF_SIZE = 4;

export interface AabbTree {
  /** Node boxes, 6 floats per node: minX, minY, minZ, maxX, maxY, maxZ. */
  readonly nodeBounds: Float32Array;
  /**
   * Per node: a leaf's first slot in {@link order}, or an inner node's left
   * child index (the right child is always `left + 1`).
   */
  readonly nodeFirst: Int32Array;
  /** Per node: item count for a leaf, 0 for an inner node. */
  readonly nodeCount: Int32Array;
  /** Item indices, grouped so every leaf owns a contiguous run. */
  readonly order: Uint32Array;
  readonly nodeTotal: number;
}

/**
 * A growable scratch list of item indices. Queries append to it rather than
 * returning a fresh array, so the per-substep hot path stays allocation-free.
 */
export class IndexList {
  items: Uint32Array;
  length = 0;

  constructor(capacity = 256) {
    this.items = new Uint32Array(capacity);
  }

  push(value: number): void {
    if (this.length === this.items.length) {
      const grown = new Uint32Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    this.items[this.length++] = value;
  }

  clear(): void {
    this.length = 0;
  }
}

/**
 * Build a tree over `count` boxes laid out 6 floats each in `boxes`.
 *
 * Splits each node at the midpoint of its centroid extent along the longest
 * axis, partitioning in place: O(n log n) with no sort. When every centroid
 * falls on one side (coincident boxes), the run is halved by position
 * instead, which always terminates. Boxes are only read during the build, so
 * the caller may drop them afterwards; queries read node bounds and the
 * caller's own exact data.
 */
export function buildAabbTree(boxes: Float32Array, count: number): AabbTree {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const maxNodes = Math.max(1, 2 * Math.ceil(count / LEAF_SIZE) + 1) * 2;
  let nodeBounds = new Float32Array(maxNodes * 6);
  let nodeFirst = new Int32Array(maxNodes);
  let nodeCount = new Int32Array(maxNodes);
  let nodeTotal = 1;

  const ensureNodes = (needed: number): void => {
    if (needed <= nodeFirst.length) return;
    const size = Math.max(needed, nodeFirst.length * 2);
    const b = new Float32Array(size * 6); b.set(nodeBounds); nodeBounds = b;
    const f = new Int32Array(size); f.set(nodeFirst); nodeFirst = f;
    const c = new Int32Array(size); c.set(nodeCount); nodeCount = c;
  };

  // Work stack of (node, start, end) triples; depth is O(log n) for midpoint
  // splits and O(log n) for the halving fallback, so 3 * 128 slots is ample,
  // but grow defensively rather than trusting that.
  let work = new Int32Array(3 * 128);
  let top = 0;
  work[top++] = 0; work[top++] = 0; work[top++] = count;

  while (top > 0) {
    const end = work[--top];
    const start = work[--top];
    const node = work[--top];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const o = order[i] * 6;
      const x0 = boxes[o], y0 = boxes[o + 1], z0 = boxes[o + 2];
      const x1 = boxes[o + 3], y1 = boxes[o + 4], z1 = boxes[o + 5];
      if (x0 < minX) minX = x0; if (y0 < minY) minY = y0; if (z0 < minZ) minZ = z0;
      if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1; if (z1 > maxZ) maxZ = z1;
      const cx = x0 + x1, cy = y0 + y1, cz = z0 + z1; // 2x centroid, compared consistently
      if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
      if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
      if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz;
    }
    const nb = node * 6;
    nodeBounds[nb] = minX; nodeBounds[nb + 1] = minY; nodeBounds[nb + 2] = minZ;
    nodeBounds[nb + 3] = maxX; nodeBounds[nb + 4] = maxY; nodeBounds[nb + 5] = maxZ;

    const n = end - start;
    if (n <= LEAF_SIZE) {
      nodeFirst[node] = start;
      nodeCount[node] = n;
      continue;
    }

    const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const split = axis === 0 ? (cMinX + cMaxX) / 2 : axis === 1 ? (cMinY + cMaxY) / 2 : (cMinZ + cMaxZ) / 2;

    let i = start;
    let j = end - 1;
    while (i <= j) {
      const o = order[i] * 6;
      if (boxes[o + axis] + boxes[o + 3 + axis] < split) {
        i++;
      } else {
        const t = order[i]; order[i] = order[j]; order[j] = t;
        j--;
      }
    }
    let mid = i;
    if (mid === start || mid === end) mid = start + (n >> 1);

    ensureNodes(nodeTotal + 2);
    const left = nodeTotal;
    nodeTotal += 2;
    nodeFirst[node] = left;
    nodeCount[node] = 0;

    if (top + 6 > work.length) {
      const grown = new Int32Array(work.length * 2);
      grown.set(work);
      work = grown;
    }
    work[top++] = left; work[top++] = start; work[top++] = mid;
    work[top++] = left + 1; work[top++] = mid; work[top++] = end;
  }

  if (count === 0) {
    nodeBounds.fill(0, 0, 6);
    nodeFirst[0] = 0;
    nodeCount[0] = 0;
  }

  return { nodeBounds, nodeFirst, nodeCount, order, nodeTotal };
}

let traversal = new Int32Array(256);

function pushTraversal(top: number, value: number): void {
  if (top === traversal.length) {
    const grown = new Int32Array(traversal.length * 2);
    grown.set(traversal);
    traversal = grown;
  }
  traversal[top] = value;
}

/**
 * Append to `out` every item whose LEAF overlaps the query box. Leaves are
 * conservative: the caller still tests each item exactly.
 */
export function queryAabbTree(
  tree: AabbTree,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  out: IndexList,
): void {
  const { nodeBounds, nodeFirst, nodeCount, order } = tree;
  if (order.length === 0) return;
  let top = 0;
  pushTraversal(top++, 0);
  while (top > 0) {
    const node = traversal[--top];
    const b = node * 6;
    if (nodeBounds[b] > maxX || nodeBounds[b + 3] < minX ||
        nodeBounds[b + 1] > maxY || nodeBounds[b + 4] < minY ||
        nodeBounds[b + 2] > maxZ || nodeBounds[b + 5] < minZ) continue;
    const n = nodeCount[node];
    if (n > 0) {
      const first = nodeFirst[node];
      for (let k = 0; k < n; k++) out.push(order[first + k]);
    } else {
      const left = nodeFirst[node];
      pushTraversal(top++, left);
      pushTraversal(top++, left + 1);
    }
  }
}

/**
 * Append to `out` every item whose leaf the ray segment `origin + t * dir`,
 * `t` in [0, `tMax`], passes through. Conservative like {@link queryAabbTree}.
 */
export function rayQueryAabbTree(
  tree: AabbTree,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
  out: IndexList,
): void {
  const { nodeBounds, nodeFirst, nodeCount, order } = tree;
  if (order.length === 0) return;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let top = 0;
  pushTraversal(top++, 0);
  while (top > 0) {
    const node = traversal[--top];
    const b = node * 6;
    if (!raySlab(ox, oy, oz, ix, iy, iz, tMax,
      nodeBounds[b], nodeBounds[b + 1], nodeBounds[b + 2],
      nodeBounds[b + 3], nodeBounds[b + 4], nodeBounds[b + 5])) continue;
    const n = nodeCount[node];
    if (n > 0) {
      const first = nodeFirst[node];
      for (let k = 0; k < n; k++) out.push(order[first + k]);
    } else {
      const left = nodeFirst[node];
      pushTraversal(top++, left);
      pushTraversal(top++, left + 1);
    }
  }
}

/** Slab test with precomputed reciprocals. An axis-parallel ray yields ±Infinity, which the min/max absorb. */
export function raySlab(
  ox: number, oy: number, oz: number,
  ix: number, iy: number, iz: number,
  tMax: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): boolean {
  let t0 = (x0 - ox) * ix, t1 = (x1 - ox) * ix;
  let near = Math.min(t0, t1), far = Math.max(t0, t1);
  t0 = (y0 - oy) * iy; t1 = (y1 - oy) * iy;
  near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
  t0 = (z0 - oz) * iz; t1 = (z1 - oz) * iz;
  near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
  // NaN (0 * Infinity on a box face) fails every comparison: treat as a hit,
  // the exact triangle test downstream decides.
  if (Number.isNaN(near) || Number.isNaN(far)) return true;
  return far >= Math.max(near, 0) && near <= tMax;
}
