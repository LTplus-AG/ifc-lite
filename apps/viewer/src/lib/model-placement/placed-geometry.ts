/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { toRenderTranslation, type Translation } from './translation.js';

export function placedMesh(mesh: MeshData, translation: Translation): MeshData {
  const delta = toRenderTranslation(translation);
  if (delta.every((value) => value === 0)) return mesh;
  const origin = mesh.origin ?? [0, 0, 0];
  const placed: MeshData = { ...mesh, origin: [origin[0] + delta[0], origin[1] + delta[1], origin[2] + delta[2]] };
  if (mesh.localToWorld) {
    placed.localToWorld = [...mesh.localToWorld];
    for (let axis = 0; axis < 3; axis++) placed.localToWorld[axis * 4 + 3] += delta[axis];
  }
  if (mesh.geometryAabb) {
    const box = mesh.geometryAabb;
    placed.geometryAabb = { ...box,
      min: [box.min[0] + delta[0], box.min[1] + delta[1], box.min[2] + delta[2]],
      max: [box.max[0] + delta[0], box.max[1] + delta[1], box.max[2] + delta[2]] };
  }
  return placed;
}

// A source realignment replaces coordinateInfo while rewriting vertex buffers.
// Scope cached local bounds to that frame as well as the buffer; pointer
// previews then translate O(meshes) boxes without scanning every vertex.
type BufferBounds = WeakMap<Float32Array, { min: number[]; max: number[] }>;
const localBounds = new WeakMap<GeometryResult['coordinateInfo'], { revision: number; buffers: BufferBounds }>();
function boundsFor(positions: Float32Array, frame: GeometryResult['coordinateInfo'], revision: number): { min: number[]; max: number[] } {
  let entry = localBounds.get(frame);
  if (!entry || entry.revision !== revision) { entry = { revision, buffers: new WeakMap() }; localBounds.set(frame, entry); }
  const { buffers } = entry;
  const cached = buffers.get(positions);
  if (cached) return cached;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  const bounds = { min, max }; buffers.set(positions, bounds); return bounds;
}

/** Transient geometry for drawings, analysis and graphical export. Original
 * arrays and source placements remain untouched. GPU occurrences are appended
 * afterwards, because the renderer already materializes those in the placed frame. */
export function placedFlatGeometry(geometry: GeometryResult, translationFor: (mesh: MeshData) => Translation, mutationVersion = 0): GeometryResult {
  const meshes = geometry.meshes.map((mesh) => placedMesh(mesh, translationFor(mesh)));
  const changed = meshes.some((mesh, index) => mesh !== geometry.meshes[index]);
  if (!changed) return geometry;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const mesh of meshes) {
    const origin = mesh.origin ?? [0, 0, 0];
    const bounds = boundsFor(mesh.positions, geometry.coordinateInfo, mutationVersion);
    min.x = Math.min(min.x, bounds.min[0] + origin[0]); min.y = Math.min(min.y, bounds.min[1] + origin[1]); min.z = Math.min(min.z, bounds.min[2] + origin[2]);
    max.x = Math.max(max.x, bounds.max[0] + origin[0]); max.y = Math.max(max.y, bounds.max[1] + origin[1]); max.z = Math.max(max.z, bounds.max[2] + origin[2]);
  }
  return { ...geometry, meshes, coordinateInfo: { ...geometry.coordinateInfo,
    shiftedBounds: Number.isFinite(min.x) ? { min, max } : geometry.coordinateInfo.shiftedBounds } };
}
