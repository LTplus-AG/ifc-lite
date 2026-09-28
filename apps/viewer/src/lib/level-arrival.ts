/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import type { AppliedEntityLevelOffsets } from '@/store/slices/levelDisplaySlice';
import type { FederatedModel } from '@/store/types';
import { placedMesh } from './model-placement/placed-geometry.js';

/** Stable geometry identity for replacement detection. A second appended piece
 * does not replace the entity; replacement of its first piece does. */
export function modelGeometryRefs(model: FederatedModel): Map<number, object> {
  const refs = new Map<number, object>();
  for (const mesh of model.geometryResult?.meshes ?? []) {
    if (!refs.has(mesh.expressId)) refs.set(mesh.expressId, mesh);
  }
  const instancedIndex = model.geometryResult?.instancedGeometryHashes;
  if (instancedIndex) for (const id of instancedIndex.keys()) {
    if (!refs.has(id)) refs.set(id, instancedIndex);
  }
  return refs;
}

/** Current lifts for renderer arrivals belonging to the same loaded stores.
 * Replacement geometry is pre-lifted at renderer ingress, so retain its old
 * applied Y here even when its mesh identity changed. A new store starts raw.
 */
export function currentLevelYForModels(
  models: ReadonlyMap<string, FederatedModel>,
  applied: AppliedEntityLevelOffsets,
): Map<number, number> {
  const offsets = new Map<number, number>();
  for (const [modelId, entry] of applied) {
    if (models.get(modelId)?.ifcDataStore !== entry.store) continue;
    for (const [globalId, y] of entry.offsets) offsets.set(globalId, y);
  }
  return offsets;
}

/**
 * Apply current Exploded lifts to only the flat meshes arriving in this batch.
 * `placedMesh` makes a renderer-owned wrapper and leaves the source mesh and its
 * vertex arrays untouched. Translation keys are global IDs, as are mesh IDs.
 */
export function placeNewMeshesAtCurrentLevel(
  meshes: MeshData[],
  currentLevelY: ReadonlyMap<number, number>,
): MeshData[] {
  if (currentLevelY.size === 0) return meshes;
  return meshes.map((mesh) => {
    // The renderer cannot move one entity inside a color-merged mesh. Match its
    // translation rule: skip pieces whose vertex IDs include another entity.
    if (mesh.entityIds?.some((id) => id !== mesh.expressId)) return mesh;
    const dy = currentLevelY.get(mesh.expressId);
    return dy === undefined || dy === 0 ? mesh : placedMesh(mesh, [0, 0, dy]);
  });
}

/** Apply Exploded lifts to instances in a newly decoded shard. IFNS transforms
 * are row-major IFC Z-up matrices; adding to translation[11] raises renderer Y.
 * IDs must be globalized before this is called.
 */
export function liftNewInstancedOccurrences(
  shard: DecodedInstancedShard,
  currentLevelY: ReadonlyMap<number, number>,
): void {
  if (currentLevelY.size === 0) return;
  for (const instance of shard.instances) {
    const dy = currentLevelY.get(instance.entityId);
    if (dy !== undefined && dy !== 0) instance.transform[11] += dy;
  }
}
