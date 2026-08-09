/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The state object every camera sub-system shares.
 *
 * This lives on its own rather than inside one of the consumers: `camera.ts`,
 * `camera-controls.ts`, `camera-animation.ts`, `camera-projection.ts`,
 * `camera-matrices.ts`, `camera-framing.ts` and `camera-first-person.ts` all
 * need the type, and declaring it inside the gesture module made four of them
 * import their core type from a sibling that is otherwise unrelated to them.
 * Owning it here turns that chain into a star.
 */

import type { Camera as CameraType, Mat4 } from './types.js';

/** Projection mode for the camera */
export type ProjectionMode = 'perspective' | 'orthographic';

/**
 * Shared mutable state for camera sub-systems.
 * All sub-systems reference the same state object so changes are visible across them.
 */
export interface CameraInternalState {
  camera: CameraType;
  viewMatrix: Mat4;
  projMatrix: Mat4;
  viewProjMatrix: Mat4;
  /** Current projection mode */
  projectionMode: ProjectionMode;
  /** Orthographic half-height in world units (controls zoom level in ortho mode) */
  orthoSize: number;
  /** Scene bounding box for tight orthographic near/far computation */
  sceneBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  /**
   * Optional outlier-robust bounds for anchoring the orbit pivot (issue #1394).
   * Distinct from `sceneBounds`: the renderer keeps `sceneBounds` synced to the
   * FULL model AABB (needed for near/far clipping and section ranges), but a
   * handful of far-flung meshes can push that AABB's centre into empty space,
   * which the orbit-pivot fallback would then rotate around. When set, the pivot
   * uses this tighter centre instead. `null` ⇒ fall back to `sceneBounds`.
   */
  orbitAnchorBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}
