/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { RetainedFaceRow } from '@/store/retainedGeometry';

/**
 * Each part's face table over its own view mesh (one mesh per part, M11-0), merged by key.
 * Rows keep source-table order (first part first), never triangle-encounter order.
 */
export function faceRows(faces: { table: string[]; triangles: Uint32Array }[], meshes: MeshData[]): RetainedFaceRow[] {
  const rows = new Map<string, RetainedFaceRow>();
  for (const part of faces) {
    for (const key of part.table) if (!rows.has(key)) rows.set(key, { key, triangles: 0, areaM2: 0 });
  }
  faces.forEach((part, i) => {
    const mesh = meshes[i];
    for (let t = 0; t < part.triangles.length; t++) {
      const key = part.table[part.triangles[t]];
      const row = rows.get(key)!;
      row.triangles++;
      if (mesh && mesh.indices.length >= 3 * t + 3) {
        const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[3 * t + k] * 3);
        const u = [0, 1, 2].map((k) => mesh.positions[b + k] - mesh.positions[a + k]);
        const v = [0, 1, 2].map((k) => mesh.positions[c + k] - mesh.positions[a + k]);
        row.areaM2 += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
  });
  return [...rows.values()].filter((row) => row.triangles > 0);
}

