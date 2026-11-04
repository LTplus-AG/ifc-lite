/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ifcToViewerAxes } from '@ifc-lite/geometry/world-frame';
import type { DecodedPointChunk } from '@ifc-lite/pointcloud';

/** Shared capture/scan convention. Neither PLY nor .splat specifies an up-axis. */
export type CaptureUpAxis = 'z' | 'y';
export function captureAxisMatrix(axis: CaptureUpAxis = 'z'): readonly number[] {
  const x = { x: 1, y: 0, z: 0 }, y = { x: 0, y: 1, z: 0 }, z = { x: 0, y: 0, z: 1 };
  const basis = axis === 'z' ? [x, y, z].map(ifcToViewerAxes) : [x, y, z];
  return [...basis.flatMap(v => [v.x, v.y, v.z, 0]), 0, 0, 0, 1];
}

/** Re-orient Z-up positions and directions into the renderer's Y-up frame. */
export function swapZupChunkToYup(chunk: DecodedPointChunk): DecodedPointChunk {
  const basis = captureAxisMatrix();
  const positions = new Float32Array(chunk.positions.length);
  const normals = chunk.normals ? new Float32Array(chunk.normals.length) : undefined;
  for (let i = 0; i < chunk.positions.length; i += 3) {
    positions[i] = chunk.positions[i];
    positions[i + 1] = basis[9] * chunk.positions[i + 2];
    positions[i + 2] = basis[6] * chunk.positions[i + 1];
    if (normals && chunk.normals) {
      normals[i] = chunk.normals[i];
      normals[i + 1] = basis[9] * chunk.normals[i + 2];
      normals[i + 2] = basis[6] * chunk.normals[i + 1];
    }
  }
  const oldMin = chunk.bbox.min, oldMax = chunk.bbox.max;
  return { ...chunk, positions, normals,
    bbox: { min: [oldMin[0], oldMin[2], -oldMax[1]], max: [oldMax[0], oldMax[2], -oldMin[1]] } };
}
