/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera projection utilities for screen/world coordinate conversion
 * and view fitting. Extracted from Camera class using composition pattern.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-controls.js';
import { MathUtils } from './math.js';
import { DEFAULT_ORTHO_SIZE, isUsableBounds } from './camera-guards.js';

/**
 * One NDC axis: `screen / extent * scale + offset`, degrading to the centre
 * of the axis when the extent is unusable.
 *
 * `extent` is a drawing-buffer dimension. It is zero before the canvas is
 * first sized and while its container is collapsed, and the division would
 * then hand back ±Infinity — or NaN, when the cursor coordinate is zero too,
 * since `0 / 0` is NaN. Neither is a position on screen.
 */
function usableNdc(screen: number, extent: number, scale: number, offset: number): number {
  if (!(Number.isFinite(extent) && extent > 0) || !Number.isFinite(screen)) return offset + scale / 2;
  return (screen / extent) * scale + offset;
}

/**
 * Handles projection math: screen-to-world and world-to-screen conversions,
 * bounding box fitting, and near/far plane management.
 */
export class CameraProjection {
  constructor(
    private readonly state: CameraInternalState,
    private readonly updateMatrices: () => void,
  ) {}

  /**
   * Project a world position to screen coordinates
   * @param worldPos - Position in world space
   * @param canvasWidth - Canvas width in pixels
   * @param canvasHeight - Canvas height in pixels
   * @returns Screen coordinates { x, y } or null if behind camera
   */
  projectToScreen(worldPos: Vec3, canvasWidth: number, canvasHeight: number): { x: number; y: number } | null {
    // Transform world position by view-projection matrix
    const m = this.state.viewProjMatrix.m;

    // Manual matrix-vector multiplication for vec4(worldPos, 1.0)
    const clipX = m[0] * worldPos.x + m[4] * worldPos.y + m[8] * worldPos.z + m[12];
    const clipY = m[1] * worldPos.x + m[5] * worldPos.y + m[9] * worldPos.z + m[13];
    const clipZ = m[2] * worldPos.x + m[6] * worldPos.y + m[10] * worldPos.z + m[14];
    const clipW = m[3] * worldPos.x + m[7] * worldPos.y + m[11] * worldPos.z + m[15];

    // Check if behind camera
    if (clipW <= 0) {
      return null;
    }

    // Perspective divide to get NDC
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const ndcZ = clipZ / clipW;

    // Check if outside clip volume
    if (ndcZ < -1 || ndcZ > 1) {
      return null;
    }

    // Convert NDC to screen coordinates
    // NDC: (-1,-1) = bottom-left, (1,1) = top-right
    // Screen: (0,0) = top-left, (width, height) = bottom-right
    const screenX = (ndcX + 1) * 0.5 * canvasWidth;
    const screenY = (1 - ndcY) * 0.5 * canvasHeight; // Flip Y

    return { x: screenX, y: screenY };
  }

  /**
   * Unproject screen coordinates to a ray in world space
   * @param screenX - X position in screen coordinates
   * @param screenY - Y position in screen coordinates
   * @param canvasWidth - Canvas width in pixels
   * @param canvasHeight - Canvas height in pixels
   * @returns Ray origin and direction in world space
   */
  unprojectToRay(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): { origin: Vec3; direction: Vec3 } {
    // Convert screen coords to NDC (-1 to 1).
    //
    // The divisors are the drawing-buffer dimensions, and a canvas can report
    // zero before its first resize or while its container is collapsed — the
    // division then yields ±Infinity and the ortho branch below writes that
    // into the ray origin. A viewport with no extent has no meaningful cursor
    // position, so the honest reading of "where is the cursor, in NDC" is
    // dead centre; that is also the answer this returns for a cursor at the
    // exact centre of a healthy canvas, so it introduces no new behaviour.
    const ndcX = usableNdc(screenX, canvasWidth, 2, -1);
    const ndcY = usableNdc(screenY, canvasHeight, -2, 1);

    // One basis for both branches, and the same one the *view matrix* is built
    // from (#2467). The orthographic branch used to recompute
    // `normalize(cross(forward, up))` itself, which has no degeneracy handling
    // at all: `MathUtils.normalize` floors on `len < 1e-10`, and that
    // comparison is false for NaN, so it divided by NaN rather than falling
    // back — a non-finite `camera.up` (a BCF `CameraUpVector` of `1e999`
    // arrives as `Infinity` through a bare `parseFloat`) returned
    // `origin = (NaN, NaN, NaN)` for BOTH NaN and Infinity, while the rendered
    // frame stayed perfectly finite. Picking and measurement live outside this
    // package and test hits with comparisons, every one of which is false
    // against NaN, so the click read as "empty space".
    const basis = MathUtils.viewBasis(
      this.state.camera.position,
      this.state.camera.target,
      this.state.camera.up,
    );

    if (this.state.projectionMode === 'orthographic') {
      // Orthographic: rays are parallel. Origin varies with screen position.
      // `orthoSize` has a read-site backstop in `Camera.updateMatrices` for
      // the projection matrix; this is the other reader, so it needs its own.
      const halfH = Number.isFinite(this.state.orthoSize) ? this.state.orthoSize : DEFAULT_ORTHO_SIZE;
      const aspect = Number.isFinite(this.state.camera.aspect) ? this.state.camera.aspect : 1;
      const halfW = halfH * aspect;

      // Ray origin: camera position offset by NDC * view extents
      const origin = {
        x: basis.eye.x + basis.right.x * ndcX * halfW + basis.up.x * ndcY * halfH,
        y: basis.eye.y + basis.right.y * ndcX * halfW + basis.up.y * ndcY * halfH,
        z: basis.eye.z + basis.right.z * ndcX * halfW + basis.up.z * ndcY * halfH,
      };

      return { origin, direction: basis.forward };
    }

    // Perspective: ray origin is always the camera position
    // Direction is computed through the screen point

    // Invert the view-projection matrix
    const invViewProj = MathUtils.invert(this.state.viewProjMatrix);
    if (!invViewProj) {
      // Fallback: return ray from camera position towards target
      return { origin: { ...basis.eye }, direction: basis.forward };
    }

    // Unproject a point at some depth to get a point on the ray
    // Using z=0.5 (midpoint in Reverse-Z: 1.0=near, 0.0=far) to get a finite point
    const worldPoint = MathUtils.transformPoint(invViewProj, { x: ndcX, y: ndcY, z: 0.5 });

    // Ray origin is the scrubbed camera position — the same one the view
    // matrix's translation row uses, so the ray belongs to the frame on
    // screen rather than to a pose that was never rendered.
    const origin = { ...basis.eye };
    const raw = {
      x: worldPoint.x - origin.x,
      y: worldPoint.y - origin.y,
      z: worldPoint.z - origin.z,
    };
    const direction = MathUtils.normalize(raw);
    // `normalize` returns the zero vector when it cannot normalize, and a
    // zero-length direction is a ray that hits nothing — the same silent miss
    // the NaN origin produced. It happens when the inverted matrix is
    // ill-conditioned enough that the unprojected point lands on the eye.
    // Look along the view direction instead: that is the ray through the
    // centre of the frame, which is where a cursor with no usable offset is.
    if (direction.x === 0 && direction.y === 0 && direction.z === 0) {
      return { origin, direction: basis.forward };
    }

    return { origin, direction };
  }

  /**
   * Fit view to bounding box
   * Sets camera to southeast isometric view (typical BIM starting view)
   * Y-up coordinate system: Y is vertical
   */
  fitToBounds(min: Vec3, max: Vec3): void {
    // Same input class, same policy as the animator's `frameBounds`/
    // `zoomExtent` (#2461): an infinite or inverted AABB has no centre and no
    // extent to fit to, and both go straight into `position` and `target`.
    if (!isUsableBounds(min, max)) return;

    const center = {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    };
    const size = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    };
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize * 2.0;

    this.state.camera.target = center;

    // Southeast isometric view for Y-up:
    // Position camera above and to the front-right of the model
    this.state.camera.position = {
      x: center.x + distance * 0.6,   // Right
      y: center.y + distance * 0.5,   // Above
      z: center.z + distance * 0.6,   // Front
    };

    // near/far are computed dynamically in updateMatrices() based on distance
    this.updateMatrices();
  }

  /**
   * Update near/far planes dynamically based on camera distance.
   * Now a no-op since updateMatrices() handles this automatically.
   * Kept for API compatibility with CameraAnimator.
   */
  updateNearFarPlanes(_distance: number): void {
    // near/far are computed dynamically in Camera.updateMatrices()
  }
}
