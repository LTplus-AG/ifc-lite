/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared f64 world-to-eye clip arithmetic for colour, pick, and shadow passes. */

import type { WorldPoint } from './relative-to-eye.js';

export interface RteClipBox {
  enabled?: boolean;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** `dot(world, normal) - distance`, expressed in the eye-relative frame. */
export function rtePlaneDistance(
  distance: number,
  normal: readonly [number, number, number],
  cameraWorld: WorldPoint,
): number {
  return distance - (cameraWorld[0] * normal[0] + cameraWorld[1] * normal[1] + cameraWorld[2] * normal[2]);
}

/** Pack a world-space crop AABB relative to `cameraWorld`, preserving f64 subtraction. */
export function packRteClipBox(
  box: RteClipBox | null | undefined,
  cameraWorld: WorldPoint,
  out: Float32Array,
  floatOffset: number,
): boolean {
  if (!box || box.enabled === false) {
    out.fill(0, floatOffset, floatOffset + 8);
    return false;
  }
  for (let axis = 0; axis < 3; axis++) {
    out[floatOffset + axis] = box.min[axis] - cameraWorld[axis];
    out[floatOffset + 4 + axis] = box.max[axis] - cameraWorld[axis];
  }
  out[floatOffset + 3] = 0;
  out[floatOffset + 7] = 0;
  return true;
}
