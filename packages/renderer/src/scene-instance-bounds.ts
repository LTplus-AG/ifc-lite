/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BoundingBox } from './scene-raycaster.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';

// Bounds/culling/CPU broad-phase read the occurrence origin from the canonical
// f64 anchors — the same source the GPU delta stream is packed from — never
// from the f32 matrix translation, which has already rounded away centimetres
// at national-grid coordinates.

export interface InstanceWorldAabb { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** Transform one local instance box and fold it into its entity's source-f64 bounds. */
export function unionInstancedWorldAabb(
  boundingBoxes: Map<number, BoundingBox>, eid: number, dv: DataView, matOffset: number,
  canonicalAnchors: Float64Array,
  lmnx: number, lmny: number, lmnz: number, lmxx: number, lmxy: number, lmxz: number,
): InstanceWorldAabb {
  const m0 = dv.getFloat32(matOffset, true), m1 = dv.getFloat32(matOffset + 4, true), m2 = dv.getFloat32(matOffset + 8, true);
  const m4 = dv.getFloat32(matOffset + 16, true), m5 = dv.getFloat32(matOffset + 20, true), m6 = dv.getFloat32(matOffset + 24, true);
  const m8 = dv.getFloat32(matOffset + 32, true), m9 = dv.getFloat32(matOffset + 36, true), m10 = dv.getFloat32(matOffset + 40, true);
  const anchor = (matOffset / INSTANCE_STRIDE_BYTES) * 3;
  const anchorX = canonicalAnchors[anchor]!, anchorY = canonicalAnchors[anchor + 1]!, anchorZ = canonicalAnchors[anchor + 2]!;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1) ? lmxx : lmnx, y = (corner & 2) ? lmxy : lmny, z = (corner & 4) ? lmxz : lmnz;
    const wx = m0 * x + m4 * y + m8 * z + anchorX, wy = m1 * x + m5 * y + m9 * z + anchorY, wz = m2 * x + m6 * y + m10 * z + anchorZ;
    minX = Math.min(minX, wx); minY = Math.min(minY, wy); minZ = Math.min(minZ, wz);
    maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy); maxZ = Math.max(maxZ, wz);
  }
  const existing = boundingBoxes.get(eid);
  if (existing) {
    existing.min.x = Math.min(existing.min.x, minX); existing.min.y = Math.min(existing.min.y, minY); existing.min.z = Math.min(existing.min.z, minZ);
    existing.max.x = Math.max(existing.max.x, maxX); existing.max.y = Math.max(existing.max.y, maxY); existing.max.z = Math.max(existing.max.z, maxZ);
  } else boundingBoxes.set(eid, { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } });
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
