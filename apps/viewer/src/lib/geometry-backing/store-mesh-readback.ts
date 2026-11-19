/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store meshes, resident or read back (#10264). Tools that take a list of store
 * meshes (caps, plan cuts, exports, quantities) pass the subset they selected;
 * each released member is answered by ITS OWN backed record: the tap writes a
 * model's store list in order, so mesh index i is record i of the current
 * generation. An optional slab limits the read to chunks meeting it, for
 * consumers that only use geometry there (a cut, a projection band).
 *
 * Fail closed: a released mesh whose model has no current, complete backing,
 * or whose backing no longer holds exactly the store list, is an error, never
 * a silently shorter result.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { MeshLease, ReadOptions } from './backing-reader';
import type { Vec3 } from './backing-directory';
import { type BackingSource, GeometryUnavailableError, meshIsResident } from './geometry-readback';

/** Points with `min <= dot(p, normal) <= max`, in the mesh frame (`origin + positions`). */
export interface Slab { normal: Vec3; min: number; max: number }

export function boxMeetsSlab(min: Vec3, max: Vec3, slab: Slab): boolean {
  let centre = 0, extent = 0;
  for (let axis = 0; axis < 3; axis++) {
    centre += slab.normal[axis] * (min[axis] + max[axis]) / 2;
    extent += Math.abs(slab.normal[axis]) * (max[axis] - min[axis]) / 2;
  }
  return centre + extent >= slab.min && centre - extent <= slab.max;
}

export interface StoreModelMeshes { modelId: string; meshes: readonly MeshData[] }

/**
 * `wanted`, with every released member replaced by its backed copy (dropped
 * when `slab` is given and its chunk does not meet it), in `wanted` order.
 */
export async function leaseStoreMeshes(
  source: BackingSource | undefined, models: Iterable<StoreModelMeshes>, wanted: readonly MeshData[],
  options: ReadOptions & { slab?: Slab } = {},
): Promise<MeshLease> {
  if (wanted.every(meshIsResident)) return { meshes: wanted, release: () => undefined };
  const owner = new Map<MeshData, { modelId: string; index: number }>();
  const lists = new Map<string, readonly MeshData[]>();
  for (const model of models) {
    lists.set(model.modelId, model.meshes);
    model.meshes.forEach((mesh, index) => owner.set(mesh, { modelId: model.modelId, index }));
  }
  const needed = new Map<string, Set<number>>();
  for (const mesh of wanted) {
    if (meshIsResident(mesh)) continue;
    const at = owner.get(mesh);
    if (!at) throw new GeometryUnavailableError(`Released mesh of entity ${mesh.expressId} belongs to no model`);
    const set = needed.get(at.modelId) ?? new Set<number>();
    set.add(at.index);
    needed.set(at.modelId, set);
  }
  const leases: MeshLease[] = [];
  const answered = new Map<MeshData, MeshData>();
  try {
    for (const [modelId, indices] of needed) {
      const backing = source?.backing(modelId);
      if (!backing?.isCurrent || !backing.isComplete) throw new GeometryUnavailableError(`Model ${modelId} has no complete current backing`);
      const chunks = backing.directory.chunks;
      const total = chunks.reduce((sum, chunk) => sum + chunk.meshCount, 0);
      if (total !== lists.get(modelId)!.length) {
        throw new GeometryUnavailableError(`Model ${modelId}'s backing holds ${total} meshes, its store list ${lists.get(modelId)!.length}`);
      }
      // Chunk k holds store indices [start_k, start_k + meshCount_k).
      const picks: Array<{ chunk: number; start: number }> = [];
      let start = 0;
      for (const chunk of chunks) {
        const end = start + chunk.meshCount;
        let hit = false;
        for (const index of indices) if (index >= start && index < end) { hit = true; break; }
        if (hit && (!options.slab || boxMeetsSlab(chunk.min, chunk.max, options.slab))) picks.push({ chunk: chunk.index, start });
        start = end;
      }
      for (const pick of picks) {
        const lease = await backing.reader.leaseChunks([pick.chunk], options);
        leases.push(lease);
        lease.meshes.forEach((mesh, offset) => {
          const index = pick.start + offset;
          if (indices.has(index)) answered.set(lists.get(modelId)![index], mesh);
        });
      }
    }
  } catch (error) {
    for (const lease of leases) lease.release();
    throw error;
  }
  const meshes: MeshData[] = [];
  for (const mesh of wanted) {
    if (meshIsResident(mesh)) meshes.push(mesh);
    else {
      const copy = answered.get(mesh);
      if (copy) meshes.push(copy);
      else if (!options.slab) throw new GeometryUnavailableError(`Mesh of entity ${mesh.expressId} was not read back`);
    }
  }
  let released = false;
  return { meshes, release: () => { if (released) return; released = true; for (const lease of leases) lease.release(); } };
}
