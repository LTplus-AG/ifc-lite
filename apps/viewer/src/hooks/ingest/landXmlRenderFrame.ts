/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds3D } from '../../utils/localParsingUtils.js';

/**
 * f32 model translations retain roughly 6 cm precision at this distance. A
 * larger render-frame coordinate is refused rather than rendered inaccurately.
 */
export const MAX_RENDER_FRAME_ORIGIN_METRES = 1_000_000;

/** Whether every extent of a source-space component fits after a frame shift. */
export function boundsFitRenderFrame(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return [
    bounds.min.x - originShift.x, bounds.min.y - originShift.y, bounds.min.z - originShift.z,
    bounds.max.x - originShift.x, bounds.max.y - originShift.y, bounds.max.z - originShift.z,
  ].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_RENDER_FRAME_ORIGIN_METRES);
}

/** Return one mesh's complete bounds in its current render frame. */
export function meshRenderFrameBounds(mesh: MeshData): Bounds3D | null {
  const origin = mesh.origin ?? [0, 0, 0];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index] + origin[0];
    const y = mesh.positions[index + 1] + origin[1];
    const z = mesh.positions[index + 2] + origin[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minX)
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : null;
}

/** Whether a mesh's complete render-frame extent remains safe for f32 upload. */
export function meshFitsRenderFrame(mesh: MeshData): boolean {
  const bounds = meshRenderFrameBounds(mesh);
  return bounds !== null && boundsFitRenderFrame(bounds, { x: 0, y: 0, z: 0 });
}
