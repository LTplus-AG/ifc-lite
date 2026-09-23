/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounding Volume Hierarchy (BVH) for spatial queries
 */

import type { AABB } from './aabb.js';
import { AABBUtils } from './aabb.js';
import type { Frustum } from './frustum.js';
import { FrustumUtils } from './frustum.js';
import { selectMedian } from './bvh-selection.js';

export interface BVHNode {
  bounds: AABB;
  left?: BVHNode;
  right?: BVHNode;
  meshIndices?: number[];
}

export interface MeshWithBounds {
  bounds: AABB;
  expressId: number;
}

export class BVH {
  private root: BVHNode | null = null;
  private meshes: MeshWithBounds[] = [];
  
  /**
   * Build BVH from meshes
   */
  static build(meshes: MeshWithBounds[]): BVH {
    const bvh = new BVH();
    bvh.meshes = meshes;
    
    if (meshes.length === 0) {
      return bvh;
    }
    
    const indices = meshes.map((_, i) => i);
    const root = bvh.emptyNode();
    bvh.root = root;
    bvh.buildNode(indices, 0, indices.length, root);
    
    return bvh;
  }

  /** Build the same tree in chunks so large models do not occupy one event-loop turn. */
  static async buildAsync(
    meshes: MeshWithBounds[],
    budgetMs: number,
    yieldToEventLoop: () => Promise<void>,
  ): Promise<BVH> {
    const bvh = new BVH();
    bvh.meshes = meshes;
    if (meshes.length === 0) return bvh;

    let chunkStart = performance.now();
    const maybeYield = async () => {
      if (performance.now() - chunkStart >= budgetMs) {
        await yieldToEventLoop();
        chunkStart = performance.now();
      }
    };
    const indices = new Array<number>(meshes.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = i;
      if (i % 1024 === 1023) await maybeYield();
    }
    const root = bvh.emptyNode();
    bvh.root = root;
    const stack = [{ start: 0, end: indices.length, node: root }];
    let processed = 0;
    while (stack.length > 0) {
      const task = stack.pop()!;
      const children = task.end - task.start > 1024
        ? await bvh.splitNodeAsync(indices, task.start, task.end, task.node, maybeYield)
        : bvh.splitNode(indices, task.start, task.end, task.node);
      if (children) {
        stack.push(children.right, children.left);
      }
      if (++processed % 16 === 0) await maybeYield();
    }
    return bvh;
  }
  
  /**
   * Query AABB - returns expressIds of meshes that intersect
   */
  queryAABB(queryBounds: AABB): number[] {
    const results: number[] = [];
    if (!this.root) return results;
    
    this.queryNode(this.root, queryBounds, results);
    return results;
  }
  
  /**
   * Raycast - returns expressIds of meshes hit by ray
   */
  raycast(origin: [number, number, number], direction: [number, number, number]): number[] {
    const results: number[] = [];
    if (!this.root) return results;
    
    // Normalize direction
    const len = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
    const dir: [number, number, number] = [
      direction[0] / len,
      direction[1] / len,
      direction[2] / len,
    ];
    
    this.raycastNode(this.root, origin, dir, results);
    return results;
  }

  /**
   * Query frustum - returns expressIds of meshes visible in frustum
   */
  queryFrustum(frustum: Frustum): number[] {
    const results: number[] = [];
    if (!this.root) return results;
    
    this.queryFrustumNode(this.root, frustum, results);
    return results;
  }
  
  private emptyNode(): BVHNode {
    return { bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
  }

  private buildNode(indices: number[], start: number, end: number, node: BVHNode): void {
    const children = this.splitNode(indices, start, end, node);
    if (!children) return;
    this.buildNode(indices, children.left.start, children.left.end, children.left.node);
    this.buildNode(indices, children.right.start, children.right.end, children.right.node);
  }

  private splitNode(indices: number[], start: number, end: number, node: BVHNode) {
    if (end - start === 1) {
      node.bounds = this.meshes[indices[start]].bounds;
      node.meshIndices = [indices[start]];
      return null;
    }

    const bounds = this.computeBounds(indices, start, end);
    node.bounds = bounds;
    const axis = this.splitAxis(bounds);
    const mid = start + Math.floor((end - start) / 2);
    const compare = (a: number, b: number) => this.compareCenters(a, b, axis);
    for (const _ of selectMedian(indices, start, end, mid, compare)) { /* synchronous drain */ }
    return this.makeChildren(node, start, mid, end);
  }

  private splitAxis(bounds: AABB): number {
    const extent = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    return extent[0] > extent[1] && extent[0] > extent[2] ? 0 :
      extent[1] > extent[2] ? 1 : 2;
  }

  private makeChildren(node: BVHNode, start: number, mid: number, end: number) {
    const left = this.emptyNode();
    const right = this.emptyNode();
    node.left = left;
    node.right = right;
    return {
      left: { start, end: mid, node: left },
      right: { start: mid, end, node: right },
    };
  }

  private async splitNodeAsync(
    indices: number[], start: number, end: number, node: BVHNode,
    maybeYield: () => Promise<void>,
  ) {
    let bounds: AABB = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = start; i < end; i += 1024) {
      const part = this.computeBounds(indices, i, Math.min(i + 1024, end));
      for (let axis = 0; axis < 3; axis++) {
        if (part.min[axis] < bounds.min[axis]) bounds.min[axis] = part.min[axis];
        if (part.max[axis] > bounds.max[axis]) bounds.max[axis] = part.max[axis];
      }
      await maybeYield();
    }
    node.bounds = bounds;
    const axis = this.splitAxis(bounds);
    const target = start + Math.floor((end - start) / 2);
    const compare = (a: number, b: number) => this.compareCenters(a, b, axis);
    for (const _ of selectMedian(indices, start, end, target, compare)) await maybeYield();
    return this.makeChildren(node, start, target, end);
  }

  private compareCenters(a: number, b: number, axis: number): number {
    const aa = this.meshes[a].bounds;
    const bb = this.meshes[b].bounds;
    const ac = (aa.min[axis] + aa.max[axis]) / 2;
    const bc = (bb.min[axis] + bb.max[axis]) / 2;
    if (ac < bc) return -1;
    if (ac > bc) return 1;
    if (Number.isNaN(ac) !== Number.isNaN(bc)) return Number.isNaN(ac) ? 1 : -1;
    return a - b;
  }

  private computeBounds(indices: number[], start: number, end: number): AABB {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    // Plain `<`/`>` comparisons, not Math.min/Math.max: a NaN operand makes
    // the comparison false and is simply skipped, whereas Math.min(x, NaN) is
    // NaN and, once mixed into an accumulator across the loop, poisons every
    // later comparison too — so a single mesh with degenerate/NaN geometry
    // (e.g. a corrupt vertex) permanently NaNs this node's aggregate bounds.
    // AABBUtils.intersects treats a NaN bound as "no intersection" on every
    // axis it touches, so that NaN'd node is pruned out of every query no
    // matter how the query box is chosen — dropping every valid sibling under
    // it too (invisible geometry under frustum culling, missed raycasts/
    // picks). Skipping the NaN contribution instead leaves the node's bounds
    // covering only its finite members, so siblings stay queryable; the NaN
    // mesh itself is still excluded on its own (its own bounds are NaN, so
    // AABBUtils.intersects against it is false, matching the Rust port's
    // `compute_bounds`, which already uses this comparison shape).
    for (let i = start; i < end; i++) {
      const idx = indices[i];
      const b = this.meshes[idx].bounds;
      if (b.min[0] < minX) minX = b.min[0];
      if (b.min[1] < minY) minY = b.min[1];
      if (b.min[2] < minZ) minZ = b.min[2];
      if (b.max[0] > maxX) maxX = b.max[0];
      if (b.max[1] > maxY) maxY = b.max[1];
      if (b.max[2] > maxZ) maxZ = b.max[2];
    }

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    };
  }
  
  private queryNode(node: BVHNode, queryBounds: AABB, results: number[]): void {
    if (!AABBUtils.intersects(node.bounds, queryBounds)) {
      return;
    }
    
    if (node.meshIndices) {
      // Leaf node - check all meshes
      for (const idx of node.meshIndices) {
        if (AABBUtils.intersects(this.meshes[idx].bounds, queryBounds)) {
          results.push(this.meshes[idx].expressId);
        }
      }
    } else {
      // Internal node - recurse
      if (node.left) this.queryNode(node.left, queryBounds, results);
      if (node.right) this.queryNode(node.right, queryBounds, results);
    }
  }
  
  private raycastNode(
    node: BVHNode,
    origin: [number, number, number],
    direction: [number, number, number],
    results: number[]
  ): void {
    if (!this.rayIntersectsAABB(origin, direction, node.bounds)) {
      return;
    }
    
    if (node.meshIndices) {
      // Leaf node - check all meshes
      for (const idx of node.meshIndices) {
        if (this.rayIntersectsAABB(origin, direction, this.meshes[idx].bounds)) {
          results.push(this.meshes[idx].expressId);
        }
      }
    } else {
      // Internal node - recurse
      if (node.left) this.raycastNode(node.left, origin, direction, results);
      if (node.right) this.raycastNode(node.right, origin, direction, results);
    }
  }
  
  private queryFrustumNode(node: BVHNode, frustum: Frustum, results: number[]): void {
    // Check if node bounds are visible in frustum
    if (!FrustumUtils.isAABBVisible(frustum, node.bounds)) {
      return;
    }
    
    if (node.meshIndices) {
      // Leaf node - check all meshes
      for (const idx of node.meshIndices) {
        if (FrustumUtils.isAABBVisible(frustum, this.meshes[idx].bounds)) {
          results.push(this.meshes[idx].expressId);
        }
      }
    } else {
      // Internal node - recurse
      if (node.left) this.queryFrustumNode(node.left, frustum, results);
      if (node.right) this.queryFrustumNode(node.right, frustum, results);
    }
  }
  
  private rayIntersectsAABB(
    origin: [number, number, number],
    direction: [number, number, number],
    aabb: AABB
  ): boolean {
    // Simplified ray-AABB intersection (slab method)
    let tmin = -Infinity;
    let tmax = Infinity;
    
    for (let i = 0; i < 3; i++) {
      if (direction[i] === 0) {
        // Ray is parallel to this axis' slab; reject if origin is outside it.
        // Avoids 0 * Infinity = NaN poisoning tmin/tmax below.
        if (origin[i] < aabb.min[i] || origin[i] > aabb.max[i]) {
          return false;
        }
        continue;
      }
      const invD = 1.0 / direction[i];
      let t0 = (aabb.min[i] - origin[i]) * invD;
      let t1 = (aabb.max[i] - origin[i]) * invD;
      
      if (invD < 0) {
        [t0, t1] = [t1, t0];
      }
      
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
      
      if (tmax < tmin) {
        return false;
      }
    }
    
    return tmax >= 0;
  }
}
