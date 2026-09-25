/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zoom toward the surface under the cursor (#5393).
 *
 * Plain wheel zoom anchors on the plane through the orbit target and dollies
 * the target forward by half of every step (`CameraControls.zoomPerspective`,
 * the anti-"Zeno" dolly), so its step has no relation to how far the surface
 * under the cursor is: repeated notches pass straight through a pipe or a
 * small building into empty space.
 *
 * With a picked surface point P, each notch instead moves the camera along the
 * cursor ray toward P by a fraction of the REMAINING distance, down to a
 * standoff. That approaches the surface asymptotically and never reaches it.
 * The camera is translated, not rotated, so P stays under the cursor; the
 * orbit target is re-seated on the view axis at P's depth, so orbit and pan
 * afterwards scale with the surface the user zoomed to rather than with the
 * old, now far-behind, target.
 */

import type { Vec3 } from './types.js';

/** Closest the camera gets to the picked surface, in scene units (metres). */
export const SURFACE_ZOOM_MIN_STANDOFF = 0.02;

export interface SurfaceZoomPose {
  position: Vec3;
  target: Vec3;
}

/**
 * One zoom-in notch toward `point`. `fraction` in (0, 1) is the share of the
 * remaining distance to cover. Returns the new pose, or null when the point is
 * unusable (non-finite, at the eye, or not in front of the camera), in which
 * case the caller falls back to plain zoom.
 */
export function surfaceZoomStep(pose: SurfaceZoomPose, point: Vec3, fraction: number): SurfaceZoomPose | null {
  const { position: p, target: t } = pose;
  if (![point.x, point.y, point.z].every(Number.isFinite) || !(fraction > 0 && fraction < 1)) return null;
  const fx = t.x - p.x, fy = t.y - p.y, fz = t.z - p.z;
  const fLen = Math.hypot(fx, fy, fz);
  if (!(fLen > 0) || !Number.isFinite(fLen)) return null;
  const forward = { x: fx / fLen, y: fy / fLen, z: fz / fLen };

  const toX = point.x - p.x, toY = point.y - p.y, toZ = point.z - p.z;
  const dist = Math.hypot(toX, toY, toZ);
  const depth0 = toX * forward.x + toY * forward.y + toZ * forward.z;
  // A point behind the eye (or on it) is no surface to approach.
  if (!(dist > 0) || !(depth0 > 0)) return null;

  // Moving along the cursor ray scales the point's depth (its distance along
  // the view axis, which is what the near plane clips) by the same factor as
  // its distance, so the standoff is enforced on depth: an off-axis point is
  // shallower than it is far.
  const next = Math.max(dist * (1 - fraction), (SURFACE_ZOOM_MIN_STANDOFF * dist) / depth0);
  const k = next < dist ? 1 - next / dist : 0; // at the standoff: hold still, never pass
  const position = { x: p.x + toX * k, y: p.y + toY * k, z: p.z + toZ * k };
  const d = depth0 * (1 - k); // the point's depth after the move, >= the standoff
  return { position, target: { x: position.x + forward.x * d, y: position.y + forward.y * d, z: position.z + forward.z * d } };
}
