/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export geometry over released CPU geometry (#10264). Export collectors are
 * synchronous (`withInstancedMeshes` and the functions built on it), so an
 * export entry point first runs `prepareReleasedExport`: every released store
 * mesh is read back by its own backed record, and every instanced occurrence
 * is materialized from the backed shards and placed in the scene frame, as
 * `Scene.getAllInstancedMeshData` would have given. The collectors then
 * substitute from that context.
 *
 * Export producers take whole mesh arrays today, so this materializes the
 * scope transiently. It is bounded: above `budgetBytes` of backed geometry it
 * fails with `GeometryUnavailableError` rather than recreating the allocation
 * the release avoided. A streaming producer interface removes that bound.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { SceneContents } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { activeGeometryBackingTap } from './backing-debug-hook';
import { GeometryUnavailableError, meshIsResident } from './geometry-readback';
import { readInstancedOccurrences } from './instanced-readback';
import { leaseStoreMeshes } from './store-mesh-readback';

export const DEFAULT_EXPORT_READBACK_BYTES = 1024 * 1024 * 1024;

export interface ReleasedExportGeometry {
  /** Released store mesh → its read-back copy (same fields, live arrays). */
  readonly flat: ReadonlyMap<MeshData, MeshData>;
  /** Every instanced occurrence of the scope, placed in the scene frame. */
  readonly instanced: readonly MeshData[];
}

export async function prepareReleasedExport(
  state: ViewerState, scene: Pick<SceneContents, 'placeAppearanceSource'> | undefined,
  modelIds: Iterable<string> = state.models.keys(), budgetBytes = DEFAULT_EXPORT_READBACK_BYTES,
): Promise<ReleasedExportGeometry> {
  const tap = activeGeometryBackingTap();
  const owners = [...modelIds];
  let bytes = 0;
  for (const modelId of owners) {
    const backing = tap?.backing(modelId);
    if (!backing?.isCurrent || !backing.isComplete) throw new GeometryUnavailableError(`Model ${modelId} has no complete current backing to export from`);
    bytes += backing.directory.storedBytes;
  }
  if (bytes > budgetBytes) {
    throw new GeometryUnavailableError(`Exporting ${bytes} bytes of released geometry exceeds the ${budgetBytes}-byte readback bound`);
  }
  const flat = new Map<MeshData, MeshData>();
  const instanced: MeshData[] = [];
  for (const modelId of owners) {
    const meshes = state.models.get(modelId)?.geometryResult?.meshes ?? [];
    const released = meshes.filter((mesh) => !meshIsResident(mesh));
    if (released.length > 0) {
      const lease = await leaseStoreMeshes(tap, [{ modelId, meshes }], released);
      released.forEach((mesh, i) => flat.set(mesh, lease.meshes[i]));
      // The copies live on through the map; the lease only pinned the decode cache.
      lease.release();
    }
    const backing = tap!.backing(modelId)!;
    const ids = new Set<number>();
    for (const shard of backing.directory.shards) for (const id of shard.entities) ids.add(id);
    if (ids.size === 0) continue;
    if (!scene?.placeAppearanceSource) throw new GeometryUnavailableError('No renderer to place instanced occurrences in the model frame');
    const modelIndex = modelIndices(state.models).get(modelId) ?? 0;
    for (const mesh of await readInstancedOccurrences(backing, ids, modelIndex, { budgetBytes: Math.max(0, budgetBytes - bytes) })) {
      instanced.push(scene.placeAppearanceSource(mesh));
    }
  }
  return { flat, instanced };
}
