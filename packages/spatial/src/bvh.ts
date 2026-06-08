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
    bvh.root = bvh.buildNode(indices, 0);
    
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
  
  private buildNode(indices: number[], depth: number): BVHNode {
    if (indices.length === 0) {
      throw new Error('Empty node');
    }
    
    if (indices.length === 1) {
      return {
        bounds: this.meshes[indices[0]].bounds,
        meshIndices: [indices[0]],
      };
    }
    
    // Compute bounds for all meshes
    const bounds = this.computeBounds(indices);
    
    // Choose split axis (longest axis)
    const extent = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const axis = extent[0] > extent[1] && extent[0] > extent[2] ? 0 :
                 extent[1] > extent[2] ? 1 : 2;
    
    // Sort by center along axis
    indices.sort((a, b) => {
      const centerA = (this.meshes[a].bounds.min[axis] + this.meshes[a].bounds.max[axis]) / 2;
      const centerB = (this.meshes[b].bounds.min[axis] + this.meshes[b].bounds.max[axis]) / 2;
      return centerA - centerB;
    });
    
    // Split in half
    const mid = Math.floor(indices.length / 2);
    const leftIndices = indices.slice(0, mid);
    const rightIndices = indices.slice(mid);
    
    return {
      bounds,
      left: this.buildNode(leftIndices, depth + 1),
      right: this.buildNode(rightIndices, depth + 1),
    };
  }
  
  private computeBounds(indices: number[]): AABB {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const idx of indices) {
      const b = this.meshes[idx].bounds;
      minX = Math.min(minX, b.min[0]);
      minY = Math.min(minY, b.min[1]);
      minZ = Math.min(minZ, b.min[2]);
      maxX = Math.max(maxX, b.max[0]);
      maxY = Math.max(maxY, b.max[1]);
      maxZ = Math.max(maxZ, b.max[2]);
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
