/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { placedMesh } from './model-placement/placed-geometry.js';

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
