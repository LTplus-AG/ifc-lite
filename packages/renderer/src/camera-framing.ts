/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framing: "put the camera on this thing, keeping the direction it already
 * has". Given the current camera state and a point or an AABB, work out the
 * pose to end up in.
 *
 * The ViewCube's *preset* directions are the neighbouring subject and live in
 * `camera-preset-view.ts`: there the direction is dictated by a named face and
 * a rotation cycle rather than inherited from the pose, and the box has to pass
 * its own admission check first. They share only the box arithmetic below,
 * which is why `centerOf` / `maxExtentOf` are exported.
 *
 * Pure by construction — every function here reads `CameraInternalState` and
 * returns a target, and none of them writes to it or touches the tween. That
 * is what keeps this module free of a cycle back into `camera-animation.ts`,
 * which is the one that applies the results. Same shape as
 * `camera-fit-policy.ts`, which is already pure-picker + facade-applier.
 *
 * Its failure story is not the tween's. The tween latches a non-finite
 * *gesture delta* into a velocity that never decays (#2441/#2473); framing
 * takes a non-finite *box* — geometry-derived, and every AABB accumulator in
 * this package hands out an inverted `+Inf/-Inf` sentinel for a mesh with no
 * finite vertices — and writes it into position, target AND `orthoSize`, which
 * `getOrthoSize()` then persists into a saved viewpoint (#2461).
 *
 * **Guard placement.** Each input is validated exactly once, here, and a
 * rejection is `null`. Callers null-check and do nothing else: a second,
 * defensive copy of the same guard in the caller would mean neither copy is
 * load-bearing on its own, and the mutation tests that pin these guards would
 * go quiet while still looking green.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { areFiniteNumbers, isUsableBounds } from './camera-guards.js';

/** A pose to animate to. `orthoSize` is undefined when the fit should not touch zoom. */
export interface FramingTarget {
  position: Vec3;
  target: Vec3;
  orthoSize?: number;
}

/** As {@link FramingTarget}, plus the fit distance `zoomExtent` reports onward. */
export interface ZoomExtentTarget extends FramingTarget {
  fitDistance: number;
}

/** An axis-aligned box. */
export interface FramingBounds {
  min: Vec3;
  max: Vec3;
}

/** Centre of a box. */
export function centerOf(min: Vec3, max: Vec3): Vec3 {
  return {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
}

/** Largest edge length of a box. */
export function maxExtentOf(min: Vec3, max: Vec3): number {
  return Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
}

/**
 * Orthographic half-height that shows a box of `maxSize` with `padding` slack,
 * or `undefined` in perspective mode where `orthoSize` is not in play.
 */
function orthoSizeFor(state: CameraInternalState, maxSize: number, padding: number): number | undefined {
  if (state.projectionMode !== 'orthographic') return undefined;
  const aspect = state.camera.aspect || 1;
  return Math.max(0.01, maxSize / 2, maxSize / 2 / aspect) * padding;
}

/**
 * Frame/center view on a point (keeps current distance and direction).
 * Standard CAD "Frame Selection" behavior.
 */
export function framePointTarget(state: CameraInternalState, point: Vec3): FramingTarget | null {
  // The point is added to the current offset and animated into both
  // `position` and `target`, so a non-finite one destroys the pose. It is
  // externally derived: `zoomToTopic` frames a BCF marker position, which is
  // computed from a file-supplied viewpoint direction (#2461/#2466).
  if (!areFiniteNumbers(point.x, point.y, point.z)) return null;

  // Keep current viewing direction and distance
  const dir = {
    x: state.camera.position.x - state.camera.target.x,
    y: state.camera.position.y - state.camera.target.y,
    z: state.camera.position.z - state.camera.target.z,
  };

  // New position: point + current offset
  return {
    position: {
      x: point.x + dir.x,
      y: point.y + dir.y,
      z: point.z + dir.z,
    },
    target: point,
  };
}

/**
 * Frame selection - zoom to fit bounds while keeping current view direction.
 * This is what "Frame Selection" should do - zoom to fill screen.
 */
export function frameBoundsTarget(state: CameraInternalState, min: Vec3, max: Vec3): FramingTarget | null {
  // Bounds are the upstream input #2450 stopped short of (#2461). They are
  // not caller-authored constants: they come from geometry, and every AABB
  // accumulator in this package starts from `min = +Infinity, max =
  // -Infinity` and only narrows on a comparison — which is false for a
  // non-finite vertex — so a mesh with no finite vertices hands out that
  // inverted sentinel as if it were a real box. `Math.max` picking the
  // largest extent is NaN-transparent, so it reaches `position`, `target`
  // AND `orthoSize`, and `getOrthoSize()` is what a saved viewpoint persists.
  if (!isUsableBounds(min, max)) return null;

  const center = centerOf(min, max);
  const maxSize = maxExtentOf(min, max);

  if (maxSize < 1e-6) {
    // Very small or zero size - just center on it
    return framePointTarget(state, center);
  }

  // Calculate required distance based on FOV to fit bounds
  const fovFactor = Math.tan(state.camera.fov / 2);
  const distance = (maxSize / 2) / fovFactor * 1.2; // 1.2x padding for nice framing

  // Get current viewing direction from view matrix (more reliable than position-target)
  // View matrix forward is -Z axis in view space
  const viewMatrix = state.viewMatrix.m;
  // Extract forward direction from view matrix (negative Z column, normalized)
  let dir = {
    x: -viewMatrix[8],   // -m[2][0] (forward X)
    y: -viewMatrix[9],   // -m[2][1] (forward Y)
    z: -viewMatrix[10],  // -m[2][2] (forward Z)
  };
  const dirLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);

  // Normalize direction
  if (dirLen > 1e-6) {
    dir.x /= dirLen;
    dir.y /= dirLen;
    dir.z /= dirLen;
  } else {
    // Fallback: use position-target if view matrix is invalid
    dir = {
      x: state.camera.position.x - state.camera.target.x,
      y: state.camera.position.y - state.camera.target.y,
      z: state.camera.position.z - state.camera.target.z,
    };
    const fallbackLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (fallbackLen > 1e-6) {
      dir.x /= fallbackLen;
      dir.y /= fallbackLen;
      dir.z /= fallbackLen;
    } else {
      // Last resort: southeast isometric
      dir.x = 0.6;
      dir.y = 0.5;
      dir.z = 0.6;
      const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      dir.x /= len;
      dir.y /= len;
      dir.z /= len;
    }
  }

  return {
    // New position: center + direction * distance
    position: {
      x: center.x + dir.x * distance,
      y: center.y + dir.y * distance,
      z: center.z + dir.z * distance,
    },
    target: center,
    // Calculate orthoSize for orthographic mode so zoom level resets properly
    orthoSize: orthoSizeFor(state, maxSize, 1.2),
  };
}

/**
 * Zoom to extents: same fit, wider padding, and the current view direction is
 * taken from the pose rather than the view matrix.
 */
export function zoomExtentTarget(state: CameraInternalState, min: Vec3, max: Vec3): ZoomExtentTarget | null {
  // Same input class and same reasoning as `frameBoundsTarget` (#2461).
  if (!isUsableBounds(min, max)) return null;

  const center = centerOf(min, max);
  const maxSize = maxExtentOf(min, max);

  // Calculate required distance based on FOV
  const fovFactor = Math.tan(state.camera.fov / 2);
  const distance = (maxSize / 2) / fovFactor * 1.5; // 1.5x for padding

  // Keep current viewing direction
  const dir = {
    x: state.camera.position.x - state.camera.target.x,
    y: state.camera.position.y - state.camera.target.y,
    z: state.camera.position.z - state.camera.target.z,
  };
  const currentDistance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);

  // Normalize direction
  if (currentDistance > 1e-10) {
    dir.x /= currentDistance;
    dir.y /= currentDistance;
    dir.z /= currentDistance;
  } else {
    // Fallback direction
    dir.x = 0.6;
    dir.y = 0.5;
    dir.z = 0.6;
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    dir.x /= len;
    dir.y /= len;
    dir.z /= len;
  }

  return {
    // New position: center + direction * distance
    position: {
      x: center.x + dir.x * distance,
      y: center.y + dir.y * distance,
      z: center.z + dir.z * distance,
    },
    target: center,
    // Calculate orthoSize for orthographic mode so zoom level resets properly
    orthoSize: orthoSizeFor(state, maxSize, 1.5),
    // The caller hands this to `CameraProjection.updateNearFarPlanes`.
    fitDistance: distance,
  };
}
