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
import { storeGeometryOwners } from './store-geometry-owners';
import { geometryOwnerNeedsReadback, type GeometryOwnerScene } from './geometry-owner-residency';

export const DEFAULT_EXPORT_READBACK_BYTES = 1024 * 1024 * 1024;

export interface ReleasedExportGeometry {
  /** Released store mesh → its read-back copy (same fields, live arrays). */
  readonly flat: ReadonlyMap<MeshData, MeshData>;
  /** Every instanced occurrence of the scope, placed in the scene frame. */
  readonly instanced: readonly MeshData[];
  /** Renderer owner indices whose live instances were replaced from the backing. */
  readonly instancedModelIndices: ReadonlySet<number>;
  /** All owners requested by this export, including owners that remain resident. */
  readonly scopeModelIndices: ReadonlySet<number>;
}

export async function prepareReleasedExport(
  state: ViewerState, scene: (Pick<SceneContents, 'placeAppearanceSource'> & GeometryOwnerScene) | undefined,
  modelIds?: Iterable<string>, budgetBytes = DEFAULT_EXPORT_READBACK_BYTES,
): Promise<ReleasedExportGeometry> {
  const tap = activeGeometryBackingTap();
  // A federation can publish its next model before that model has geometry.
  // Such an entry contributes nothing to the view and needs no backing yet.
  // Preserve shard-only geometry and reject explicitly missing model owners.
  const sources = new Map(storeGeometryOwners(state).map((owner) => [owner.modelId, owner]));
  const indices = modelIndices(state.models);
  const requested = [...(modelIds ?? sources.keys())];
  const scopeModelIndices = new Set(requested.map((id) => indices.get(id) ?? 0));
  const owners = requested.filter((modelId) => {
    const model = sources.get(modelId);
    if (!model) return true; // Explicitly missing owners must still fail.
    const hasShards = (tap?.backing(modelId)?.directory.shards.length ?? 0) > 0;
    // Skipped only while the renderer holds no released instances for it either; otherwise refuse (r4652872766).
    if (model.geometryResult == null && !hasShards && !geometryOwnerNeedsReadback([], scene, indices.get(modelId) ?? 0)) return false;
    return geometryOwnerNeedsReadback(model.geometryResult?.meshes ?? [], scene, indices.get(modelId) ?? 0);
  });
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
  const instancedModelIndices = new Set<number>();
  for (const modelId of owners) {
    const meshes = sources.get(modelId)?.geometryResult?.meshes ?? [];
    const released = meshes.filter((mesh) => !meshIsResident(mesh));
    if (released.length > 0) {
      const lease = await leaseStoreMeshes(tap, [{ modelId, meshes }], released, { budgetBytes });
      released.forEach((mesh, i) => flat.set(mesh, lease.meshes[i]));
      // The copies live on through the map; the lease only pinned the decode cache.
      lease.release();
    }
    const backing = tap!.backing(modelId)!;
    const ids = new Set<number>();
    for (const shard of backing.directory.shards) for (const id of shard.entities) ids.add(id);
    if (ids.size === 0) continue;
    if (!scene?.placeAppearanceSource) throw new GeometryUnavailableError('No renderer to place instanced occurrences in the model frame');
    const modelIndex = indices.get(modelId) ?? 0;
    instancedModelIndices.add(modelIndex);
    for (const mesh of await readInstancedOccurrences(backing, ids, modelIndex, { budgetBytes: Math.max(0, budgetBytes - bytes) })) {
      instanced.push(scene.placeAppearanceSource(mesh));
    }
  }
  return { flat, instanced, instancedModelIndices, scopeModelIndices };
}
