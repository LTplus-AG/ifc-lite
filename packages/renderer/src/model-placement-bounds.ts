/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Scene } from './scene.js';
import type { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';

export function modelPlacementBounds(
  scene: Scene, points: PointCloudRenderer | null, modelIndex: number, handle?: { id: number },
  translation?: readonly [number, number, number],
) {
  const applied = scene.getModelTranslation(modelIndex);
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const include = (bounds: { min: readonly number[]; max: readonly number[] } | null | undefined, from = applied) => {
    if (!bounds || !bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return;
    for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
      const delta = translation ? translation[i] - from[i] : 0;
      min[axis] = Math.min(min[axis], bounds.min[i] + delta);
      max[axis] = Math.max(max[axis], bounds.max[i] + delta);
    }
  };
  for (const batch of scene.getBatchedMeshes()) if ((batch.modelIndices?.[0] ?? 0) === modelIndex) include(batch.bounds);
  for (const mesh of scene.getMeshes()) if (!mesh.hydrated && (mesh.modelIndex ?? 0) === modelIndex) include(mesh.bounds);
  for (const template of scene.getInstancedTemplates()) if (template.modelIndex === modelIndex) include(template.bounds);
  for (const mesh of scene.getTexturedMeshes()) {
    if ((mesh.modelIndex ?? 0) !== modelIndex) continue;
    include(mesh.bounds);
  }
  // Streamed scans and scene meshes are placed by separate renderer calls.
  include(points?.getPlacementBounds(modelIndex, handle), handle && points?.getAssetTranslation(handle));
  return Number.isFinite(min.x) ? { min, max } : null;
}

export function sceneMeshBounds(scene: Scene) {

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (const batch of [...scene.getBatchedMeshes(), ...scene.getTexturedMeshes(), ...scene.getInstancedTemplates(), ...scene.getMeshes().filter((mesh) => !mesh.hydrated)]) {
      if (!batch.bounds || !batch.bounds.min.every(Number.isFinite) || !batch.bounds.max.every(Number.isFinite)) continue;
      any = true;
      if (batch.bounds.min[0] < minX) minX = batch.bounds.min[0];
      if (batch.bounds.min[1] < minY) minY = batch.bounds.min[1];
      if (batch.bounds.min[2] < minZ) minZ = batch.bounds.min[2];
      if (batch.bounds.max[0] > maxX) maxX = batch.bounds.max[0];
      if (batch.bounds.max[1] > maxY) maxY = batch.bounds.max[1];
      if (batch.bounds.max[2] > maxZ) maxZ = batch.bounds.max[2];
  }
  if (!any) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}
