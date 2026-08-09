/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View / projection / view-projection matrix derivation.
 *
 * One subject: camera state in, three finite matrices out. Its failure story
 * is the #2441 near/far backstops — a non-finite pose or `orthoSize` must not
 * reach the projection matrix, because `MathUtils.lookAt` scrubs the *view*
 * matrix but nothing scrubs the projection one, and a NaN there leaves the
 * viewport dead while every other reading looks healthy.
 *
 * **Hot path.** `updateCameraMatrices` runs on every frame the camera moves.
 * It takes the shared state object **by reference** and nothing else: do not
 * destructure it into parameters (that allocates an arguments object per
 * frame) and do not widen the parameter to a structural supertype (that
 * invites megamorphic dispatch). The allocation profile is deliberately
 * unchanged from the method this replaced — `lookAt`, `perspectiveReverseZ` /
 * `orthographicReverseZ` and `multiply` each already return a fresh `Mat4`,
 * and the ortho branch already returned a fresh `{near, far}` per frame.
 */

import { MathUtils } from './math.js';
import type { CameraInternalState } from './camera-state.js';
import { DEFAULT_ORTHO_SIZE } from './camera-guards.js';

export function updateCameraMatrices(state: CameraInternalState): void {
  const dx = state.camera.position.x - state.camera.target.x;
  const dy = state.camera.position.y - state.camera.target.y;
  const dz = state.camera.position.z - state.camera.target.z;
  const rawDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // A non-finite position or target — a malformed BCF viewpoint reaches the
  // public setters unvalidated — would put NaN into near/far and from there
  // into the projection matrix, leaving the viewport dead even though
  // `MathUtils.lookAt` scrubs the view matrix (#2441). Fall back to a
  // neutral distance so the projection stays finite; the camera state itself
  // is left as the caller set it.
  const distance = Number.isFinite(rawDistance) ? rawDistance : 1;

  state.viewMatrix = MathUtils.lookAt(
    state.camera.position,
    state.camera.target,
    state.camera.up
  );

  if (state.projectionMode === 'orthographic') {
    // Orthographic: project scene bounding sphere onto view direction for tight near/far.
    // Tight range maximizes depth precision (less z-fighting) and prevents clipping.
    const nf = computeOrthoNearFar(state, distance);
    state.camera.near = nf.near;
    state.camera.far = nf.far;
    // Backstop for the writers that never see `setOrthoSize`'s clamp: the
    // orthographic zoom scales `orthoSize` in place and the animator
    // interpolates it, so a NaN reaching either (from a malformed pose, or
    // from bounds that were themselves non-finite) would land straight in
    // the projection matrix. Same fallback shape as the distance above.
    const h = Number.isFinite(state.orthoSize) ? state.orthoSize : DEFAULT_ORTHO_SIZE;
    const w = h * state.camera.aspect;
    state.projMatrix = MathUtils.orthographicReverseZ(
      -w, w, -h, h,
      state.camera.near,
      state.camera.far
    );
  } else {
    // Perspective: adapt near/far based on camera-to-target distance
    state.camera.near = Math.max(0.01, distance * 0.001);
    state.camera.far = Math.max(distance * 10, 1000);
    state.projMatrix = MathUtils.perspectiveReverseZ(
      state.camera.fov,
      state.camera.aspect,
      state.camera.near,
      state.camera.far
    );
  }

  state.viewProjMatrix = MathUtils.multiply(state.projMatrix, state.viewMatrix);
}

/**
 * Compute tight near/far for orthographic mode by projecting the scene
 * bounding sphere onto the camera view direction.
 *
 * This gives optimal depth precision (minimizing z-fighting) while ensuring
 * no geometry is clipped regardless of camera position or view angle.
 */
export function computeOrthoNearFar(
  state: CameraInternalState,
  distance: number,
): { near: number; far: number } {
  const bounds = state.sceneBounds;
  if (!bounds) {
    // Fallback: generous range centered on camera
    return { near: -Math.max(distance, 500), far: Math.max(distance, 500) };
  }

  // Scene bounding sphere center and radius
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const ex = bounds.max.x - bounds.min.x;
  const ey = bounds.max.y - bounds.min.y;
  const ez = bounds.max.z - bounds.min.z;
  const radius = Math.sqrt(ex * ex + ey * ey + ez * ez) / 2;

  // View direction (camera looks from position toward target)
  const pos = state.camera.position;
  let vx = state.camera.target.x - pos.x;
  let vy = state.camera.target.y - pos.y;
  let vz = state.camera.target.z - pos.z;
  const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (vLen > 1e-8) { vx /= vLen; vy /= vLen; vz /= vLen; }

  // Signed distance from camera to scene center along view direction
  const toCenter = (cx - pos.x) * vx + (cy - pos.y) * vy + (cz - pos.z) * vz;

  // Near/far as distances from camera along view direction.
  // The sphere spans [toCenter - radius, toCenter + radius] along view dir.
  // Add 10% padding for safety.
  const pad = radius * 0.1 + 1;
  let near = toCenter - radius - pad;
  let far = toCenter + radius + pad;

  // Ensure minimum range for depth precision
  if (far - near < 1) { near -= 0.5; far += 0.5; }

  // Same contract as the perspective branch: a non-finite camera position or
  // scene bound must not reach the projection matrix (#2441).
  if (!Number.isFinite(near) || !Number.isFinite(far)) {
    const fallback = Math.max(Number.isFinite(distance) ? distance : 0, 500);
    return { near: -fallback, far: fallback };
  }

  return { near, far };
}
