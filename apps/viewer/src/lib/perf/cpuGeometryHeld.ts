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

import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';

/** The renderer's visitor contract (`Renderer.visitCpuGeometry`), without widening the package's exports. */
type CpuGeometryVisitor = Parameters<Renderer['visitCpuGeometry']>[0];
type CpuGeometryKind = Parameters<CpuGeometryVisitor>[2];

/** Store meshes: the same arrays the renderer's walk visits for its own pieces. */
function visitMeshArrays(owner: string, mesh: MeshData, visit: CpuGeometryVisitor): void {
  visit(owner, mesh.positions, 'positions');
  visit(owner, mesh.normals, 'normals');
  visit(owner, mesh.indices, 'indices');
  if (mesh.entityIds) visit(owner, mesh.entityIds, 'other');
  if (mesh.uvs) visit(owner, mesh.uvs, 'other');
  const source = mesh.appearanceSource;
  if (source) {
    visit(owner, source.indices, 'indices');
    visit(owner, source.sourceIndices, 'indices');
    if (source.cornerIndices) visit(owner, source.cornerIndices, 'indices');
  }
}

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
    const snapshot = ownerStats.map(stats => ({ ...stats }));
    const byKind: Record<CpuGeometryKind, number> = { positions: 0, normals: 0, indices: 0, other: 0 };
    let totalBytes = 0, sharedBytes = 0;
    for (const { bytes, owners, kind } of buffers.values()) {
      totalBytes += bytes;
      byKind[kind] += bytes;
      const single = (owners & (owners - 1)) === 0;
      if (!single) sharedBytes += bytes;
      for (let i = 0; i < ownerStats.length; i++) {
        if (!(owners & (1 << i))) continue;
        snapshot[i].reachableBytes += bytes;
        if (single) snapshot[i].exclusiveBytes += bytes;
      }
    }
    const owners: Record<string, CpuGeometryOwnerBytes> = {};
    for (const [name, i] of ownerIndex) owners[name] = snapshot[i];
    return { totalBytes, buffers: buffers.size, byKind, sharedBytes, owners, walkMs };
  };
  return { visit, result };
}

type MeshList = { meshes?: readonly MeshData[] | null } | null | undefined;

export interface CpuGeometrySources {
  /** Per-model geometry results (the store's `models`), with the pre-alignment copy georeferenced federated models keep. */
  models?: Iterable<{ geometryResult?: MeshList; preAlignment?: { positions?: readonly Float32Array[]; normals?: readonly (Float32Array | undefined)[] } | null }>;
  /** The delete-undo stash (the store's `removedMeshes`). */
  removedMeshes?: Iterable<{ meshes?: readonly MeshData[] }>;
  /** The store's top-level `geometryResult` (single-model path; may be the same object as a model's). */
  geometryResult?: MeshList;
  /** Renderer-side holders (scene, raycast index); absent before the viewport is ready. */
  renderer?: { visitCpuGeometry(visit: CpuGeometryVisitor): void } | null;
}

/** One sample of the figure from the given holders. */
export function measureCpuGeometryHeld(sources: CpuGeometrySources): CpuGeometryHeld {
  const start = performance.now();
  const account = createCpuGeometryAccount();
  const seenLists = new Map<string, Set<readonly MeshData[]>>();
  const visitList = (owner: string, list: readonly MeshData[] | null | undefined) => {
    if (!list) return;
    let seen = seenLists.get(owner);
    if (!seen) seenLists.set(owner, (seen = new Set()));
    if (seen.has(list)) return;
    seen.add(list);
    for (const mesh of list) visitMeshArrays(owner, mesh, account.visit);
  };
  const models = [...(sources.models ?? [])];
  for (const model of models) visitList('store.models', model.geometryResult?.meshes);
  for (const model of models) {
    // A copy of positions and normals per mesh, not views of the mesh arrays (#4970 restore baseline).
    for (const array of model.preAlignment?.positions ?? []) account.visit('store.preAlignment', array, 'positions');
    for (const array of model.preAlignment?.normals ?? []) if (array) account.visit('store.preAlignment', array, 'normals');
  }
  for (const stash of sources.removedMeshes ?? []) visitList('store.removedMeshes', stash.meshes);
  // The top-level result aliases the active model; report it only when distinct.
  if (!models.some(model => model.geometryResult?.meshes === sources.geometryResult?.meshes)) {
    visitList('store.geometryResult', sources.geometryResult?.meshes);
  }
  sources.renderer?.visitCpuGeometry(account.visit);
  return account.result(performance.now() - start);
}
