/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frustum culling helpers
 */

import type { AABB } from './aabb.js';

export interface Frustum {
  planes: Plane[];
}

export interface Plane {
  normal: [number, number, number];
  distance: number;
}

export class FrustumUtils {
  // Small negative threshold for plane distance checks.
  // Prevents boundary flickering when AABBs are right at the frustum edge —
  // without this, floating-point jitter during orbit can flip the sign of the
  // distance between successive frames, causing batches to pop in and out.
  private static readonly PLANE_EPSILON = -0.5;

  /**
   * Check if AABB is inside frustum
   */
  static isAABBVisible(frustum: Frustum, aabb: AABB): boolean {
    // Fail closed on a non-finite box (NaN/Infinity from corrupt geometry)
    // instead of letting it fall through the plane loop. Every plane
    // comparison below is `distance < PLANE_EPSILON`, and a comparison
    // against NaN is always false, so a NaN-bounded box would never trip
    // the reject branch on any of the six planes and this function would
    // return true — visible — for a box that `AABBUtils.intersects` and the
    // raycast path both already treat as absent. Checked once, up front,
    // rather than per-plane: it's the same six components either way, and
    // this skips all six plane distance computations when it fires instead
    // of running them first and discarding the result.
    if (
      !Number.isFinite(aabb.min[0]) || !Number.isFinite(aabb.min[1]) || !Number.isFinite(aabb.min[2]) ||
      !Number.isFinite(aabb.max[0]) || !Number.isFinite(aabb.max[1]) || !Number.isFinite(aabb.max[2])
    ) {
      return false;
    }

    for (const plane of frustum.planes) {
      // Find the "positive vertex" - the vertex of the AABB that is farthest
      // in the positive direction of the plane normal
      const positiveVertex: [number, number, number] = [
        plane.normal[0] > 0 ? aabb.max[0] : aabb.min[0],
        plane.normal[1] > 0 ? aabb.max[1] : aabb.min[1],
        plane.normal[2] > 0 ? aabb.max[2] : aabb.min[2],
      ];

      // Check if positive vertex is behind the plane (with small margin)
      const distance = this.pointToPlaneDistance(positiveVertex, plane);
      if (distance < FrustumUtils.PLANE_EPSILON) {
        return false; // AABB is completely outside frustum
      }
    }

    return true;
  }
  
  /**
   * Compute distance from point to plane
   */
  private static pointToPlaneDistance(point: [number, number, number], plane: Plane): number {
    return (
      point[0] * plane.normal[0] +
      point[1] * plane.normal[1] +
      point[2] * plane.normal[2] +
      plane.distance
    );
  }
  
  /**
   * Create frustum from view-projection matrix
   */
  static fromViewProjMatrix(viewProj: Float32Array | number[]): Frustum {
    // Extract frustum planes from 4x4 view-projection matrix
    // Matrix is column-major: m[0-3] = col0, m[4-7] = col1, etc.
    
    const m = viewProj;
    const planes: Plane[] = [];
    
    // Left plane
    planes.push({
      normal: [
        m[3] + m[0],
        m[7] + m[4],
        m[11] + m[8],
      ],
      distance: m[15] + m[12],
    });
    
    // Right plane
    planes.push({
      normal: [
        m[3] - m[0],
        m[7] - m[4],
        m[11] - m[8],
      ],
      distance: m[15] - m[12],
    });
    
    // Bottom plane
    planes.push({
      normal: [
        m[3] + m[1],
        m[7] + m[5],
        m[11] + m[9],
      ],
      distance: m[15] + m[13],
    });
    
    // Top plane
    planes.push({
      normal: [
        m[3] - m[1],
        m[7] - m[5],
        m[11] - m[9],
      ],
      distance: m[15] - m[13],
    });
    
    // Near plane (WebGPU clip space: z >= 0, so just row 2)
    planes.push({
      normal: [
        m[2],
        m[6],
        m[10],
      ],
      distance: m[14],
    });
    
    // Far plane
    planes.push({
      normal: [
        m[3] - m[2],
        m[7] - m[6],
        m[11] - m[10],
      ],
      distance: m[15] - m[14],
    });
    
    // Normalize all planes
    for (const plane of planes) {
      const len = Math.sqrt(
        plane.normal[0] ** 2 +
        plane.normal[1] ** 2 +
        plane.normal[2] ** 2
      );
      if (len > 0) {
        plane.normal[0] /= len;
        plane.normal[1] /= len;
        plane.normal[2] /= len;
        plane.distance /= len;
      }
    }
    
    return { planes };
  }
}
