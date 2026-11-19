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
import { releasedAncestry } from '@/lib/released-mesh-provenance';
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

/** Fields that live in the backed record, not on a released store mesh or a copy of one. */
const RECORD_FIELDS = new Set<keyof MeshData>(['positions', 'normals', 'indices', 'appearanceSource', 'texture']);

/**
 * A released mesh (or a copy of one: a recolour, a federation `modelIndex`
 * re-home, a placement) answered by its backed record: the record's arrays
 * under the copy's own current scalars, so placement and model identity are
 * reapplied exactly as on the resident copy.
 */
export function mergeReleased(copy: MeshData, record: MeshData): MeshData {
  const merged: MeshData = { ...copy };
  const fields = merged as unknown as Partial<Record<keyof MeshData, unknown>>;
  for (const key of RECORD_FIELDS) {
    if (Object.hasOwn(record, key)) fields[key] = record[key];
    else delete fields[key];
  }
  return merged;
}

/** The canonical store mesh a released mesh or copy descends from. */
export function canonicalStoreMesh<T>(mesh: MeshData, known: ReadonlyMap<MeshData, T>): { source: MeshData; at: T } | undefined {
  const own = known.get(mesh);
  if (own !== undefined) return { source: mesh, at: own };
  for (const source of releasedAncestry(mesh)) {
    const at = known.get(source);
    if (at !== undefined) return { source, at };
  }
  return undefined;
}

/** The read-back answer for a released store mesh or any copy of one, under the copy's scalars. */
export function releasedCopyFrom(readBack: ReadonlyMap<MeshData, MeshData>, mesh: MeshData): MeshData | undefined {
  const found = canonicalStoreMesh(mesh, readBack);
  return found ? mergeReleased(mesh, found.at) : undefined;
}

export const DEFAULT_STORE_READBACK_BYTES = 256 * 1024 * 1024;

/**
 * `wanted`, with every released member (store mesh or copy) replaced by its
 * backed record under its own scalars, dropped when `slab` is given and its
 * chunk does not meet it, in `wanted` order. Bounded by `budgetBytes` of
 * leased chunks; above it this fails rather than pin the model.
 */
export async function leaseStoreMeshes(
  source: BackingSource | undefined, models: Iterable<StoreModelMeshes>, wanted: readonly MeshData[],
  options: ReadOptions & { slab?: Slab; budgetBytes?: number } = {},
): Promise<MeshLease> {
  if (wanted.every(meshIsResident)) return { meshes: wanted, release: () => undefined };
  const owner = new Map<MeshData, { modelId: string; index: number }>();
  const lists = new Map<string, readonly MeshData[]>();
  for (const model of models) {
    lists.set(model.modelId, model.meshes);
    model.meshes.forEach((mesh, index) => owner.set(mesh, { modelId: model.modelId, index }));
  }
  const leases: MeshLease[] = [];
  const release = () => { for (const lease of leases.splice(0)) lease.release(); };
  try {
    // Released members by model: store index -> the wanted meshes it answers.
    const needed = new Map<string, Map<number, MeshData[]>>();
    const offsets = new Map<MeshData, number[]>();
    for (const mesh of wanted) {
      if (meshIsResident(mesh)) continue;
      const found = canonicalStoreMesh(mesh, owner);
      if (!found) throw new GeometryUnavailableError(`Released mesh of entity ${mesh.expressId} belongs to no model`);
      const { modelId, index } = found.at;
      const byIndex = needed.get(modelId) ?? new Map<number, MeshData[]>();
      byIndex.set(index, [...(byIndex.get(index) ?? []), mesh]);
      needed.set(modelId, byIndex);
      // A placed copy's frame differs from the backed (store) frame by its origin shift.
      const o = mesh.origin ?? [0, 0, 0], so = found.source.origin ?? [0, 0, 0];
      offsets.set(mesh, [o[0] - so[0], o[1] - so[1], o[2] - so[2]]);
    }
    const budget = options.budgetBytes ?? DEFAULT_STORE_READBACK_BYTES;
    let leasedBytes = 0;
    const answered = new Map<MeshData, MeshData>();
    for (const [modelId, byIndex] of needed) {
      const backing = source?.backing(modelId);
      if (!backing?.isCurrent || !backing.isComplete) throw new GeometryUnavailableError(`Model ${modelId} has no complete current backing`);
      const chunks = backing.directory.chunks;
      const total = chunks.reduce((sum, chunk) => sum + chunk.meshCount, 0);
      if (total !== lists.get(modelId)!.length) {
        throw new GeometryUnavailableError(`Model ${modelId}'s backing holds ${total} meshes, its store list ${lists.get(modelId)!.length}`);
      }
      let start = 0;
      for (const chunk of chunks) {
        const end = start + chunk.meshCount;
        let hit = false;
        for (const [index, copies] of byIndex) {
          if (index < start || index >= end) continue;
          hit = copies.some((copy) => {
            if (!options.slab) return true;
            const { normal, min, max } = options.slab, delta = offsets.get(copy)!;
            const shift = normal[0] * delta[0] + normal[1] * delta[1] + normal[2] * delta[2];
            return boxMeetsSlab(chunk.min, chunk.max, { normal, min: min - shift, max: max - shift });
          });
          if (hit) break;
        }
        if (hit) {
          leasedBytes += chunk.bytes;
          if (leasedBytes > budget) throw new GeometryUnavailableError(`Released geometry readback exceeds its ${budget}-byte bound`);
          const lease = await backing.reader.leaseChunks([chunk.index], options);
          leases.push(lease);
          lease.meshes.forEach((record, offset) => {
            for (const copy of byIndex.get(start + offset) ?? []) answered.set(copy, mergeReleased(copy, record));
          });
        }
        start = end;
      }
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
    let done = false;
    return { meshes, release: () => { if (done) return; done = true; release(); } };
  } catch (error) {
    release();
    throw error;
  }
}
