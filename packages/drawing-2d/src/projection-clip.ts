/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig } from './types.js';
import { getViewDirectionForPlane } from './projection-bands.js';
import { clipMeshToHalfSpace } from './half-space-clip.js';

/** Clip in 3D BEFORE discarding depth in a projected footprint (#6615).
 * Origins and source buffers are preserved by the existing clipper. */
export function clipMeshToProjectionWindow(
  mesh: MeshData, plane: SectionPlaneConfig, minDepth: number, maxDepth: number,
): MeshData | null {
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || maxDepth <= minDepth) return null;
  const view = getViewDirectionForPlane(plane);
  const offset = (plane.customPlane?.distance ?? plane.position) * (plane.flipped ? 1 : -1);
  const far = clipMeshToHalfSpace(mesh, view, offset + maxDepth).mesh;
  if (!far) return null;
  return clipMeshToHalfSpace(far, { x: -view.x, y: -view.y, z: -view.z }, -offset - minDepth).mesh;
}

export function projectionBandMeshes(mesh: MeshData, plane: SectionPlaneConfig, below: number, above: number): MeshData[] {
  return [clipMeshToProjectionWindow(mesh, plane, 0, below),
    clipMeshToProjectionWindow(mesh, plane, -above, 0)].filter((m): m is MeshData => m !== null);
}
