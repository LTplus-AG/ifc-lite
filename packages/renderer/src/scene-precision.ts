/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { originPreservesTriangleTopology, recordsDescribe } from '@ifc-lite/geometry/gpu-records';
export { originPreservesTriangleTopology }; // one definition, shared with the geometry workers
import type { MeshData } from '@ifc-lite/geometry';

export function worldBounds(meshes: readonly MeshData[]): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const p = mesh.positions;
    const ox = mesh.origin?.[0] ?? 0;
    const oy = mesh.origin?.[1] ?? 0;
    const oz = mesh.origin?.[2] ?? 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** World-space bbox centre selected by the automatic batch-frame path. */
export function automaticBatchOrigin(meshes: readonly MeshData[]): [number, number, number] {
  const { minX, minY, minZ, maxX, maxY, maxZ } = worldBounds(meshes);
  return Number.isFinite(minX)
    ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
    : [0, 0, 0];
}

/**
 * Memo of topology verdicts, keyed by mesh then by origin. The scan is
 * O(triangles) and one append asks the same (mesh, origin) question from the
 * input validation and again from bucket routing, so a non-streaming append
 * creates one memo and threads it through. A stream keeps one from its first
 * append to its finalize swap (`StreamAssembly.topology`): its fragments, the
 * finalize re-group and the final batches ask again. Positions must not change
 * in place while a memo is live; the scene drops the stream's on such edits.
 * `scans` counts real scans (cache misses), `hits` the verdicts served from it.
 */
export class TopologyMemo {
  scans = 0;
  hits = 0;
  /** Per mesh, flat (x, y, z, verdict) quads: a mesh meets one or two frames, so a scan beats a string-keyed map. */
  private readonly verdicts = new Map<MeshData, number[]>();

  preserves(mesh: MeshData, origin: readonly [number, number, number]): boolean {
    let perMesh = this.verdicts.get(mesh);
    if (!perMesh) { perMesh = []; this.verdicts.set(mesh, perMesh); }
    for (let i = 0; i < perMesh.length; i += 4) {
      if (perMesh[i] === origin[0] && perMesh[i + 1] === origin[1] && perMesh[i + 2] === origin[2]) {
        this.hits++;
        return perMesh[i + 3] === 1;
      }
    }
    const records = mesh.gpuRecords; // encoded only after this same check passed in this frame
    if (records && recordsDescribe(records, mesh) && records.frame[0] === origin[0] && records.frame[1] === origin[1] && records.frame[2] === origin[2]) {
      this.hits++;
      return true;
    }
    this.scans++;
    const verdict = originPreservesTriangleTopology([mesh], origin);
    perMesh.push(origin[0], origin[1], origin[2], verdict ? 1 : 0);
    return verdict;
  }

  /** Same contract as `originPreservesTriangleTopology`, memoized per mesh. */
  all(meshes: readonly MeshData[], origin: readonly [number, number, number]): boolean {
    return meshes.every((mesh) => this.preserves(mesh, origin));
  }
}


/** Prefer shared frames; preserve authored f32 coordinates when a bbox rebase loses detail. */
export function topologySafeBatchOrigin(
  meshes: readonly MeshData[],
  inherited: [number, number, number] | undefined,
  shared: [number, number, number] | undefined,
  routing: [number, number, number] | undefined = undefined,
  memo?: TopologyMemo,
): [number, number, number] | undefined {
  const preserves = (origin: readonly [number, number, number]): boolean =>
    memo ? memo.all(meshes, origin) : originPreservesTriangleTopology(meshes, origin);
  for (const requested of [inherited, shared, routing]) {
    if (requested && preserves(requested)) return requested;
  }
  const automatic = automaticBatchOrigin(meshes);
  if (preserves(automatic)) return automatic;
  // #6515: a wide mesh can contain valid tiny triangles near its local origin.
  // Recentering it rounds those vertices together even though its original
  // f32 frame still preserves them. Try one authored frame, validated against
  // every mesh, rather than treating exhausted preferred frames as exhaustion
  // of all frames. GPU high/low origin lanes must remain finite too (#5010).
  const authored: [number, number, number] = meshes[0]?.origin ?? [0, 0, 0];
  return authored.every((axis) => Number.isFinite(Math.fround(axis)))
    && preserves(authored) ? authored : undefined;
}
