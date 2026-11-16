/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "CPU geometry held" (#10264 S0): bytes of mesh geometry the main thread
 * still references after GPU upload, split by holder. Counts the
 * `byteLength` of each distinct underlying buffer once, so one worker-batch
 * arena viewed by hundreds of meshes, or one array shared by the store's mesh
 * and the scene's shallow copy of it, is counted once. Nothing is copied;
 * released (zero-length) and detached arrays count zero. Runs only when asked
 * (`__ifc_lite_cpu_geometry_held__()`), never on a hot path.
 */

import { visitMeshArrays, type CpuGeometryKind, type CpuGeometryVisitor } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';

export interface CpuGeometryOwnerBytes {
  /** Distinct buffer bytes reachable from this holder. */
  reachableBytes: number;
  /** Distinct buffer bytes reachable from this holder only: what letting go of it alone would free. */
  exclusiveBytes: number;
  /** Sum of the byteLength of the views this holder was handed (logical data, may repeat across holders). */
  viewBytes: number;
  views: number;
}

export interface CpuGeometryHeld {
  /** Distinct underlying buffer bytes across all holders. */
  totalBytes: number;
  /** Distinct buffers counted (non-empty). */
  buffers: number;
  /** Buffer bytes by the kind of the first view that reached each buffer. */
  byKind: Record<CpuGeometryKind, number>;
  /** Buffer bytes reachable from more than one holder. */
  sharedBytes: number;
  owners: Record<string, CpuGeometryOwnerBytes>;
  /** Wall time of the walk, ms. */
  walkMs: number;
}

interface BufferEntry { bytes: number; owners: number; kind: CpuGeometryKind }

/** Accumulates views by holder; `result()` folds them into distinct-buffer bytes. */
export function createCpuGeometryAccount(): { visit: CpuGeometryVisitor; result(walkMs?: number): CpuGeometryHeld } {
  const ownerIndex = new Map<string, number>();
  const ownerStats: CpuGeometryOwnerBytes[] = [];
  // Owner sets are bitmasks: more than 31 holders would be a bug in the caller.
  const buffers = new Map<ArrayBufferLike, BufferEntry>();
  const visit: CpuGeometryVisitor = (owner, array, kind) => {
    let index = ownerIndex.get(owner);
    if (index === undefined) {
      index = ownerIndex.size;
      if (index > 30) throw new Error(`cpu geometry account: too many holders (${owner})`);
      ownerIndex.set(owner, index);
      ownerStats.push({ reachableBytes: 0, exclusiveBytes: 0, viewBytes: 0, views: 0 });
    }
    const stats = ownerStats[index];
    stats.views++;
    stats.viewBytes += array.byteLength; // 0 for a detached or released view
    const buffer = array.buffer;
    const bytes = buffer.byteLength;
    if (bytes === 0) return;
    const entry = buffers.get(buffer);
    if (entry) entry.owners |= 1 << index;
    else buffers.set(buffer, { bytes, owners: 1 << index, kind });
  };
  const result = (walkMs = 0): CpuGeometryHeld => {
    const byKind: Record<CpuGeometryKind, number> = { positions: 0, normals: 0, indices: 0, other: 0 };
    let totalBytes = 0, sharedBytes = 0;
    for (const { bytes, owners, kind } of buffers.values()) {
      totalBytes += bytes;
      byKind[kind] += bytes;
      const single = (owners & (owners - 1)) === 0;
      if (!single) sharedBytes += bytes;
      for (let i = 0; i < ownerStats.length; i++) {
        if (!(owners & (1 << i))) continue;
        ownerStats[i].reachableBytes += bytes;
        if (single) ownerStats[i].exclusiveBytes += bytes;
      }
    }
    const owners: Record<string, CpuGeometryOwnerBytes> = {};
    for (const [name, i] of ownerIndex) owners[name] = ownerStats[i];
    return { totalBytes, buffers: buffers.size, byKind, sharedBytes, owners, walkMs };
  };
  return { visit, result };
}

type MeshList = { meshes?: readonly MeshData[] | null } | null | undefined;

export interface CpuGeometrySources {
  /** Per-model geometry results (the store's `models`). */
  models?: Iterable<{ geometryResult?: MeshList }>;
  /** The store's top-level `geometryResult` (single-model path; may be the same object as a model's). */
  geometryResult?: MeshList;
  /** Renderer-side holders (scene, raycast index); absent before the viewport is ready. */
  renderer?: { visitCpuGeometry(visit: CpuGeometryVisitor): void } | null;
}

/** One sample of the figure from the given holders. */
export function measureCpuGeometryHeld(sources: CpuGeometrySources): CpuGeometryHeld {
  const start = performance.now();
  const account = createCpuGeometryAccount();
  const seenLists = new Set<readonly MeshData[]>();
  const visitList = (owner: string, list: readonly MeshData[] | null | undefined) => {
    if (!list || seenLists.has(list)) return; // the same list under two store fields is one holder
    seenLists.add(list);
    for (const mesh of list) visitMeshArrays(owner, mesh, account.visit);
  };
  for (const model of sources.models ?? []) visitList('store.models', model.geometryResult?.meshes);
  visitList('store.geometryResult', sources.geometryResult?.meshes);
  sources.renderer?.visitCpuGeometry(account.visit);
  return account.result(performance.now() - start);
}
