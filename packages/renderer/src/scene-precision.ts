/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

/** Whether an f64 rebase followed by the real f32 upload retains every valid triangle. */
export function originPreservesTriangleTopology(
  meshes: readonly MeshData[],
  origin: readonly [number, number, number],
): boolean {
  const areaSquared = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): number => {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    return nx * nx + ny * ny + nz * nz;
  };
  for (const mesh of meshes) {
    const p = mesh.positions;
    const ox = (mesh.origin?.[0] ?? 0) - origin[0];
    const oy = (mesh.origin?.[1] ?? 0) - origin[1];
    const oz = (mesh.origin?.[2] ?? 0) - origin[2];
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const ai = mesh.indices[i] * 3, bi = mesh.indices[i + 1] * 3, ci = mesh.indices[i + 2] * 3;
      const sourceArea = areaSquared(
        p[ai], p[ai + 1], p[ai + 2], p[bi], p[bi + 1], p[bi + 2], p[ci], p[ci + 1], p[ci + 2],
      );
      if (!(Number.isFinite(sourceArea) && sourceArea > 0)) continue;
      const shiftedArea = areaSquared(
        Math.fround(p[ai] + ox), Math.fround(p[ai + 1] + oy), Math.fround(p[ai + 2] + oz),
        Math.fround(p[bi] + ox), Math.fround(p[bi + 1] + oy), Math.fround(p[bi + 2] + oz),
        Math.fround(p[ci] + ox), Math.fround(p[ci + 1] + oy), Math.fround(p[ci + 2] + oz),
      );
      if (!(Number.isFinite(shiftedArea) && shiftedArea > 0)) return false;
    }
  }
  return true;
}

/** Prefer the inherited/shared frame, then validate the automatic bbox frame. */
export function topologySafeBatchOrigin(
  meshes: readonly MeshData[],
  inherited: [number, number, number] | undefined,
  shared: [number, number, number] | undefined,
  routing: [number, number, number] | undefined = undefined,
): [number, number, number] | undefined {
  for (const requested of [inherited, shared, routing]) {
    if (requested && originPreservesTriangleTopology(meshes, requested)) return requested;
  }
  const automatic = automaticBatchOrigin(meshes);
  return originPreservesTriangleTopology(meshes, automatic) ? automatic : undefined;
}
