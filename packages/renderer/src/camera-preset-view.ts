/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preset views: the ViewCube's six named directions, plus the admission check
 * that decides whether a preset may be applied at all.
 *
 * Split out of `camera-framing.ts`, which owns the *free* framing pickers
 * (point / bounds / extents — "put the camera on this thing, keeping the
 * current direction"). Presets are the opposite subject: the direction is
 * dictated by the named face and the caller's rotation cycle, and the box is
 * whatever the caller supplied or whatever the current pose implies. The two
 * share the box arithmetic and the corner fit, which is why this module
 * imports `centerOf` / `fitDistanceFor` rather than owning a second copy.
 *
 * Pure by construction, exactly as `camera-framing.ts` is: everything here
 * reads `CameraInternalState` and returns a target, nothing writes to it or
 * touches the tween. That is what keeps both modules free of a cycle back into
 * `camera-animation.ts`, which is the one that applies the results.
 *
 * **Guard placement.** `resolvePresetBounds` validates the box exactly once,
 * here, and a rejection is `null`. Callers null-check and do nothing else: a
 * second, defensive copy of the same guard in the caller would mean neither
 * copy is load-bearing on its own, and the mutation test that pins this guard
 * would go quiet while still looking green.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { isUsableBounds } from './camera-guards.js';
import { centerOf, fitDistanceFor, type FramingBounds } from './camera-framing.js';
import { viewBasis } from './math.js';
import { CAMERA_CONSTANTS } from './constants.js';

/**
 * The ~0.6 degree tilt that keeps the top and bottom presets off the pole, so
 * the orbit math that follows has a well-defined polar tangent.
 */
const POLE_TILT_SIN = Math.sin(0.01);
const POLE_TILT_COS = Math.cos(0.01);

/**
 * Get current bounds estimate (simplified - in production would use scene bounds).
 */
export function estimateBoundsFromPose(state: CameraInternalState): FramingBounds {
  // Estimate bounds from camera distance
  const dir = {
    x: state.camera.position.x - state.camera.target.x,
    y: state.camera.position.y - state.camera.target.y,
    z: state.camera.position.z - state.camera.target.z,
  };
  const distance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  const size = distance / 2;

  return {
    min: {
      x: state.camera.target.x - size,
      y: state.camera.target.y - size,
      z: state.camera.target.z - size,
    },
    max: {
      x: state.camera.target.x + size,
      y: state.camera.target.y + size,
      z: state.camera.target.z + size,
    },
  };
}

/**
 * Resolve the box a preset view should fit, from the caller's bounds or the
 * current pose, and reject it if it is not usable.
 *
 * This is the whole admission decision for `setPresetView`, deliberately kept
 * ahead of the rotation-cycling counter: a rejected preset must not advance
 * the cycle, and the caller can only honour that if the verdict arrives before
 * it mutates anything.
 */
export function resolvePresetBounds(
  state: CameraInternalState,
  bounds?: FramingBounds,
): FramingBounds | null {
  const useBounds = bounds || estimateBoundsFromPose(state);
  // Both sources need the check, not just the caller's: the pose-derived
  // estimate above starts from the live pose, so a pose that is already
  // malformed produces a malformed box and the ViewCube would then bake it in
  // permanently. Rejecting leaves the preset un-applied, which keeps a
  // recoverable pose recoverable (#2461).
  if (!isUsableBounds(useBounds.min, useBounds.max)) {
    console.warn('[Camera] Non-finite bounds for setPresetView; keeping current view');
    return null;
  }
  return useBounds;
}

/**
 * Pose for a preset view (Y-up coordinate system).
 *
 * `bounds` must already have passed {@link resolvePresetBounds}; `rotation` is
 * the caller's 0-3 cycle position, which is why this takes it rather than
 * owning it — the counter belongs to the animator, which is what remembers
 * that the same face was clicked twice.
 *
 * @param buildingRotation Optional building rotation in radians (from IfcSite placement)
 */
export function presetViewTarget(
  state: CameraInternalState,
  view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
  bounds: FramingBounds,
  rotation: number,
  buildingRotation?: number,
): { position: Vec3; target: Vec3; up: Vec3 } {
  const center = centerOf(bounds.min, bounds.max);

  // Unit offset from the centre to the camera, per named face. The fit
  // distance depends on it — the box's projected extent is a property of the
  // direction it is seen from — so the switch below picks the direction and
  // the standoff is applied once, afterwards.
  let offsetDir: Vec3;

  // WebGL uses Y-up coordinate system internally
  // We set both position AND up vector for proper orthogonal views
  let upVector: Vec3 = { x: 0, y: 1, z: 0 }; // Default Y-up

  // Apply building rotation if present (rotate around Y axis).
  //
  // Normalized rather than trusted: this is the IfcSite placement angle,
  // derived from the file and threaded through `Camera.setPresetView` — the
  // published entry point — without ever meeting a guard. `Math.cos(NaN)` is
  // NaN, and the four horizontal presets multiply it straight into the offset,
  // so a malformed placement would send the ViewCube to a non-finite pose. A
  // zero rotation is the same answer as "no rotation supplied", which is what
  // the undefined case already resolves to.
  const rotationRadians = Number.isFinite(buildingRotation) ? (buildingRotation as number) : 0;
  const cosR = rotationRadians !== 0 ? Math.cos(rotationRadians) : 1.0;
  const sinR = rotationRadians !== 0 ? Math.sin(rotationRadians) : 0.0;

  switch (view) {
    case 'top': {
      // Top view: position camera *just barely* off the +Y pole so the
      // subsequent orbit math has a well-defined polar tangent (no pole
      // singularity). camera.up stays world Y throughout — screen-up is
      // then determined by lookAt projecting (0,1,0) onto perp(look),
      // which falls along the horizontal component of `-look`.
      //
      // The 4 rotation cycles select which compass direction appears at
      // the top of the screen by varying the small horizontal offset
      // (theta in the spherical math).
      //   rotation 0 → camera slightly to +Z of center → screen-up = +Z
      //   rotation 1 → camera slightly to +X → screen-up = +X
      //   rotation 2 → camera slightly to -Z → screen-up = -Z
      //   rotation 3 → camera slightly to -X → screen-up = -X
      // Building rotation is applied as the same Y-axis rotation that
      // setPresetView would have used to remap the legacy up vector.
      const poleOffset = POLE_TILT_SIN;
      const verticalOffset = POLE_TILT_COS;
      // `?? 0`: `rotation` is the animator's 0-3 cycle counter today, but it
      // is a plain `number` on the signature, and an out-of-range, fractional
      // or non-finite one indexes past the table and makes `thetaWorld` — and
      // with it the whole preset pose — NaN.
      const thetaPerRotation = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      const thetaWorld = (thetaPerRotation[rotation] ?? 0) + rotationRadians;
      offsetDir = {
        x: poleOffset * Math.sin(thetaWorld),
        y: verticalOffset,
        z: poleOffset * Math.cos(thetaWorld),
      };
      upVector = { x: 0, y: 1, z: 0 };
      break;
    }
    case 'bottom': {
      // Bottom view: mirror of top — phi = π − MIN_PHI.
      const poleOffset = POLE_TILT_SIN;
      const verticalOffset = POLE_TILT_COS;
      const thetaPerRotation = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];
      const thetaWorld = (thetaPerRotation[rotation] ?? 0) + rotationRadians;
      offsetDir = {
        x: poleOffset * Math.sin(thetaWorld),
        y: -verticalOffset,
        z: poleOffset * Math.cos(thetaWorld),
      };
      upVector = { x: 0, y: 1, z: 0 };
      break;
    }
    case 'front':
      // Front view: from +Z looking at model
      // Rotate camera position around Y axis by building rotation
      // Standard rotation: x' = x*cos - z*sin, z' = x*sin + z*cos
      // For +Z direction (0,0,1): x' = -sin, z' = cos
      // But we need to look at building's front, so use negative rotation
      offsetDir = { x: sinR, y: 0, z: cosR };
      upVector = { x: 0, y: 1, z: 0 }; // Y-up
      break;
    case 'back':
      // Back view: from -Z looking at model
      // For -Z direction (0,0,-1) rotated: x' = sin, z' = -cos
      offsetDir = { x: -sinR, y: 0, z: -cosR };
      upVector = { x: 0, y: 1, z: 0 }; // Y-up
      break;
    case 'left':
      // Left view: from -X looking at model
      // For -X direction (-1,0,0) rotated: x' = -cos, z' = sin
      offsetDir = { x: -cosR, y: 0, z: sinR };
      upVector = { x: 0, y: 1, z: 0 }; // Y-up
      break;
    case 'right':
      // Right view: from +X looking at model
      // For +X direction (1,0,0) rotated: x' = cos, z' = -sin
      offsetDir = { x: cosR, y: 0, z: -sinR };
      upVector = { x: 0, y: 1, z: 0 }; // Y-up
      break;
  }

  // The standoff that keeps every corner of the box on screen from this
  // direction, with 1.5x padding. `viewBasis` is the same function
  // `MathUtils.lookAt` will build the real view matrix with, so the axes here
  // are the ones the frame is drawn in — including the substitute up axis a
  // near-vertical top/bottom preset gets. It is given `offsetDir` about the
  // origin rather than the real pose because it only ever uses `eye - target`,
  // and the difference at the real centre is the same direction with the low
  // bits of a georeferenced coordinate rounded off it.
  const basis = viewBasis(offsetDir, { x: 0, y: 0, z: 0 }, upVector);
  const distance = fitDistanceFor(state, bounds, basis, CAMERA_CONSTANTS.ZOOM_EXTENT_PADDING);

  return {
    // Off the basis rather than off `offsetDir`, so the standoff is the
    // distance whatever length the switch above happened to build.
    position: {
      x: center.x - basis.forward.x * distance,
      y: center.y - basis.forward.y * distance,
      z: center.z - basis.forward.z * distance,
    },
    target: center,
    up: upVector,
  };
}
