/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Ray } from './raycaster.js';

const MAX_MESHES_PER_LEAF = 8;

const F32 = new Float32Array(1);
const F32_BITS = new Uint32Array(F32.buffer);

/** Largest float32 <= v, so a stored lower bound never moves inward. */
function f32Floor(v: number): number {
  const r = Math.fround(v);
  if (!(r > v)) return r;
  F32[0] = r;
  if (r > 0) F32_BITS[0]--;
  else if (r < 0) F32_BITS[0]++;
  else F32_BITS[0] = 0x80000001; // v is a tiny negative: the smallest negative subnormal
  return F32[0];
}

/** Smallest float32 >= v, so a stored upper bound never moves inward. */
function f32Ceil(v: number): number {
  const r = Math.fround(v);
  if (!(r < v)) return r;
  F32[0] = r;
  if (r > 0) F32_BITS[0]++;
  else if (r < 0) F32_BITS[0]--;
  else F32_BITS[0] = 1; // v is a tiny positive: the smallest positive subnormal
  return F32[0];
}

/**
 * Median-split BVH held in typed arrays and split in place, so a build over
 * millions of meshes allocates a few flat buffers rather than a node object
 * and a sorted copy per level (#9504).
 */
export class BVH {
  // Per-mesh world AABB (minX,minY,minZ,maxX,maxY,maxZ). World = f64 origin +
  // f32 position, so each bound is rounded OUTWARD to f32: round-to-nearest
  // could shrink a narrow box at georeferenced coordinates and drop a real hit.
  // An empty mesh keeps Infinity/-Infinity: it adds nothing to a union, its NaN
  // centroid only picks a side, and a node holding only empty meshes is pruned.
  private meshAABBs: Float32Array | null = null;
  // Mesh indices, permuted so every leaf owns one contiguous range.
  private order: Int32Array | null = null;
  // Six floats per node; node 0 is the root.
  private nodeBounds: Float32Array | null = null;
  // Internal node: [left, right], both > 0. Leaf: [start, -count].
  private nodeLinks: Int32Array | null = null;
  private nodeCount = 0;
  private stack = new Int32Array(64);

  /**
   * Build BVH from meshes
   */
  build(meshes: readonly MeshData[]): void {
    const n = meshes.length;
    this.nodeCount = 0;
    if (n === 0) {
      this.meshAABBs = this.order = this.nodeBounds = this.nodeLinks = null;
      return;
    }

    const aabbs = new Float32Array(n * 6);
    for (let m = 0; m < n; m++) {
      const positions = meshes[m].positions;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      // Positions are element-local (world = origin + position); the ray is world-space.
      const orig = meshes[m].origin;
      const ox = orig ? orig[0] : 0, oy = orig ? orig[1] : 0, oz = orig ? orig[2] : 0;
      const o = m * 6;
      aabbs[o] = f32Floor(minX + ox);
      aabbs[o + 1] = f32Floor(minY + oy);
      aabbs[o + 2] = f32Floor(minZ + oz);
      aabbs[o + 3] = f32Ceil(maxX + ox);
      aabbs[o + 4] = f32Ceil(maxY + oy);
      aabbs[o + 5] = f32Ceil(maxZ + oz);
    }
    this.meshAABBs = aabbs;

    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    this.order = order;
    // A median split stops at <= 8, so with n > 8 every leaf holds >= 4 meshes:
    // at most n/4 leaves and 2 * leaves - 1 nodes.
    const capacity = 2 * Math.ceil(n / 4) + 1;
    this.nodeBounds = new Float32Array(capacity * 6);
    this.nodeLinks = new Int32Array(capacity * 2);
    this.buildNode(0, n);
  }

  /**
   * Get meshes that potentially intersect with ray
   */
  getMeshesForRay(ray: Ray, meshes: readonly MeshData[]): number[] {
    if (this.nodeCount === 0) return meshes.map((_, i) => i);

    const result: number[] = [];
    const { origin, direction } = ray;
    const o = [origin.x, origin.y, origin.z];
    const inv = [1 / direction.x, 1 / direction.y, 1 / direction.z];
    // Only a component whose reciprocal overflows is parallel: any finite one,
    // however small, still crosses slabs and must be slab-tested (#9504).
    const parallel = [!Number.isFinite(inv[0]), !Number.isFinite(inv[1]), !Number.isFinite(inv[2])];
    const bounds = this.nodeBounds!, links = this.nodeLinks!, order = this.order!;
    let stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    traversal: while (top > 0) {
      const node = stack[--top];
      const b = node * 6;
      // Slab test; a ray parallel to an axis must start inside that slab.
      let tmin = -Infinity, tmax = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        const low = bounds[b + axis], high = bounds[b + 3 + axis];
        if (!(low <= high)) continue traversal; // only empty meshes below
        if (parallel[axis]) {
          if (o[axis] < low || o[axis] > high) continue traversal;
          continue;
        }
        let t0 = (low - o[axis]) * inv[axis], t1 = (high - o[axis]) * inv[axis];
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) continue traversal;
      }
      if (tmax < 0) continue; // box entirely behind the ray origin

      const a = links[node * 2], c = links[node * 2 + 1];
      if (c < 0) {
        for (let i = a, end = a - c; i < end; i++) result.push(order[i]);
        continue;
      }
      if (top + 2 > stack.length) {
        const grown = new Int32Array(stack.length * 2);
        grown.set(stack);
        stack = this.stack = grown;
      }
      stack[top++] = c;
      stack[top++] = a;
    }
    return result;
  }

  /** Build the node for order[start, end) and return its index. */
  private buildNode(start: number, end: number): number {
    const node = this.allocNode();
    const aabbs = this.meshAABBs!, order = this.order!;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const o = order[i] * 6;
      if (aabbs[o] < minX) minX = aabbs[o];
      if (aabbs[o + 1] < minY) minY = aabbs[o + 1];
      if (aabbs[o + 2] < minZ) minZ = aabbs[o + 2];
      if (aabbs[o + 3] > maxX) maxX = aabbs[o + 3];
      if (aabbs[o + 4] > maxY) maxY = aabbs[o + 4];
      if (aabbs[o + 5] > maxZ) maxZ = aabbs[o + 5];
    }
    const bounds = this.nodeBounds!, b = node * 6;
    bounds[b] = minX;
    bounds[b + 1] = minY;
    bounds[b + 2] = minZ;
    bounds[b + 3] = maxX;
    bounds[b + 4] = maxY;
    bounds[b + 5] = maxZ;

    const count = end - start;
    if (count <= MAX_MESHES_PER_LEAF) {
      this.nodeLinks![node * 2] = start;
      this.nodeLinks![node * 2 + 1] = -count;
      return node;
    }

    // Longest axis, then a median split on cached centroids.
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    const axis = ex > ey && ex > ez ? 0 : ey > ez ? 1 : 2;
    const mid = start + (count >> 1);
    this.selectMedian(start, end - 1, mid, axis);
    const left = this.buildNode(start, mid);
    const right = this.buildNode(mid, end);
    this.nodeLinks![node * 2] = left;
    this.nodeLinks![node * 2 + 1] = right;
    return node;
  }

  private allocNode(): number {
    const node = this.nodeCount++;
    if (node * 2 >= this.nodeLinks!.length) {
      const bounds = new Float32Array(this.nodeBounds!.length * 2);
      bounds.set(this.nodeBounds!);
      this.nodeBounds = bounds;
      const links = new Int32Array(this.nodeLinks!.length * 2);
      links.set(this.nodeLinks!);
      this.nodeLinks = links;
    }
    return node;
  }

  /** Hoare quickselect: partitions order[lo..hi] around `target` by centroid on `axis`. */
  private selectMedian(lo: number, hi: number, target: number, axis: number): void {
    const aabbs = this.meshAABBs!, order = this.order!;
    const center = (index: number) => aabbs[index * 6 + axis] + aabbs[index * 6 + 3 + axis];
    while (hi > lo) {
      const pivot = center(order[(lo + hi) >> 1]);
      let i = lo, j = hi;
      while (i <= j) {
        while (center(order[i]) < pivot) i++;
        while (center(order[j]) > pivot) j--;
        if (i <= j) {
          const swap = order[i];
          order[i] = order[j];
          order[j] = swap;
          i++;
          j--;
        }
      }
      if (target <= j) hi = j;
      else if (target >= i) lo = i;
      else return;
    }
  }
}
