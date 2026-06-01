/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ray/mesh intersection for the `raycast` tool. Pure geometry — no model or
 * tool-context coupling — so it is trivially unit-testable.
 */

import type { MeshData } from '@ifc-lite/geometry';

export interface RayHit {
  expressId: number;
  ifcType: string | null;
  distance: number;
  point: [number, number, number];
}

/**
 * Nearest ray/mesh hit by Möller–Trumbore over every triangle, in the meshes'
 * own (tessellated) coordinate frame. The direction is normalized internally so
 * `distance` is in world units. Brute force over triangles — fine for the
 * one-shot headless casts this tool serves.
 */
export function castRay(
  meshes: MeshData[],
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
): RayHit | null {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (len === 0) return null;
  const dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
  const EPS = 1e-7;
  let best: RayHit | null = null;

  for (const mesh of meshes) {
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const hx = dy * e2z - dz * e2y;
      const hy = dz * e2x - dx * e2z;
      const hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det > -EPS && det < EPS) continue; // ray parallel to triangle
      const inv = 1 / det;
      const sx = origin[0] - p[a], sy = origin[1] - p[a + 1], sz = origin[2] - p[a + 2];
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t <= EPS) continue; // behind the origin
      if (!best || t < best.distance) {
        best = {
          expressId: mesh.expressId,
          ifcType: mesh.ifcType ?? null,
          distance: t,
          point: [origin[0] + dx * t, origin[1] + dy * t, origin[2] + dz * t],
        };
      }
    }
  }
  return best;
}
