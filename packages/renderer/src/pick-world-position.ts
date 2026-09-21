/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MathUtils } from './math.js';
import type { RelativeToEyeSnapshot } from './relative-to-eye.js';

/** Reproject a pick pixel/depth pair through a reverse-Z view projection. */
export function unprojectPickSample(
  viewProj: Float32Array,
  pickX: number,
  pickY: number,
  width: number,
  height: number,
  depth: number,
): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(depth) || depth <= 0) return null;
  const ndcX = ((pickX + 0.5) / width) * 2 - 1;
  const ndcY = 1 - ((pickY + 0.5) / height) * 2;
  const inverse = MathUtils.invert({ m: viewProj });
  return inverse ? MathUtils.transformPoint(inverse, { x: ndcX, y: ndcY, z: depth }) : null;
}

/** Restore the f64 camera translation after an RTE depth unprojection. */
export function restoreRtePickWorld(
  relative: { x: number; y: number; z: number } | null,
  snapshot: RelativeToEyeSnapshot,
): { x: number; y: number; z: number } | null {
  if (!relative) return null;
  const camera = snapshot.getCameraWorld();
  return { x: relative.x + camera[0], y: relative.y + camera[1], z: relative.z + camera[2] };
}
