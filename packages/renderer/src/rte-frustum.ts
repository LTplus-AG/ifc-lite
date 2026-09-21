/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frustum operations in the renderer's relative-to-eye coordinate frame.
 *
 * WebGPU consumes eye-relative vertices, so extracting planes from an
 * absolute f32 view-projection and testing national-grid bounds against them
 * is both a different coordinate system and a precision loss.  These helpers
 * keep the matrix and AABB in the same frame.  The source-space conversion is
 * only for the BVH API, which stores its immutable boxes in source f64 space.
 */

import { FrustumUtils, type Frustum } from '@ifc-lite/spatial';
import type { RelativeToEyeFrame } from './relative-to-eye.js';

export type RteBounds = { min: readonly [number, number, number]; max: readonly [number, number, number] };

export function rteFrustum(frame: RelativeToEyeFrame): Frustum {
  return FrustumUtils.fromViewProjMatrix(frame.getViewProjection().m);
}

/** Test source/world f64 bounds against an eye-relative frustum. */
export function isRteAabbVisible(
  frustum: Frustum,
  bounds: RteBounds,
  cameraWorld: readonly [number, number, number],
): boolean {
  return FrustumUtils.isAABBVisible(frustum, {
    min: [
      bounds.min[0] - cameraWorld[0],
      bounds.min[1] - cameraWorld[1],
      bounds.min[2] - cameraWorld[2],
    ],
    max: [
      bounds.max[0] - cameraWorld[0],
      bounds.max[1] - cameraWorld[1],
      bounds.max[2] - cameraWorld[2],
    ],
  });
}

/**
 * Convert the eye-relative planes back to source f64 space for `SpatialIndex`.
 * This changes plane distance only: `n·(p - camera) + d = n·p + d'`.
 */
export function sourceFrustumFromRte(frustum: Frustum, cameraWorld: readonly [number, number, number]): Frustum {
  return {
    planes: frustum.planes.map((plane) => ({
      normal: [...plane.normal] as [number, number, number],
      distance: plane.distance - plane.normal[0] * cameraWorld[0]
        - plane.normal[1] * cameraWorld[1] - plane.normal[2] * cameraWorld[2],
    })),
  };
}
