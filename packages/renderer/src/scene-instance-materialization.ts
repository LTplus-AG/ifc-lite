/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
interface Occurrence { templateIndex: number; byteOffset: number; originalColor: [number, number, number, number]; itemId?: number }
interface Template { positions: Float32Array; normals: Float32Array; indices: Uint32Array; instanceData: ArrayBuffer }
/** CPU display expansion only: f32 instance transforms are not canonical IFC provenance. */
export function materializeInstances(expressId: number, occ: readonly Occurrence[], templates: readonly (Template | undefined)[]): MeshData[] | undefined {
    const out: MeshData[] = [];
    for (const o of occ) {
      const tpl = templates[o.templateIndex];
      if (!tpl || tpl.positions.length === 0) continue;
      const dv = new DataView(tpl.instanceData);
      const b = o.byteOffset;
      const m0 = dv.getFloat32(b + 0, true), m1 = dv.getFloat32(b + 4, true), m2 = dv.getFloat32(b + 8, true);
      const m4 = dv.getFloat32(b + 16, true), m5 = dv.getFloat32(b + 20, true), m6 = dv.getFloat32(b + 24, true);
      const m8 = dv.getFloat32(b + 32, true), m9 = dv.getFloat32(b + 36, true), m10 = dv.getFloat32(b + 40, true);
      const m12 = dv.getFloat32(b + 48, true), m13 = dv.getFloat32(b + 52, true), m14 = dv.getFloat32(b + 56, true);
      const n = tpl.positions.length;
      const positions = new Float32Array(n);
      const normals = new Float32Array(tpl.normals.length);
      for (let i = 0; i < n; i += 3) {
        const x = tpl.positions[i], y = tpl.positions[i + 1], z = tpl.positions[i + 2];
        positions[i] = m0 * x + m4 * y + m8 * z + m12;
        positions[i + 1] = m1 * x + m5 * y + m9 * z + m13;
        positions[i + 2] = m2 * x + m6 * y + m10 * z + m14;
        if (i + 2 < tpl.normals.length) {
          // Rotate normals by the upper-3×3 (instancing transforms are rigid +
          // uniform scale, so this is correct up to a renormalize).
          const nx = tpl.normals[i], ny = tpl.normals[i + 1], nz = tpl.normals[i + 2];
          let rx = m0 * nx + m4 * ny + m8 * nz;
          let ry = m1 * nx + m5 * ny + m9 * nz;
          let rz = m2 * nx + m6 * ny + m10 * nz;
          const len = Math.hypot(rx, ry, rz) || 1;
          rx /= len; ry /= len; rz /= len;
          normals[i] = rx; normals[i + 1] = ry; normals[i + 2] = rz;
        }
      }
      const color: [number, number, number, number] = [...o.originalColor];
      // Per-occurrence key so CPU caches that would otherwise key on `expressId`
      // alone (measure-snap geometry cache) don't collide across occurrences of
      // this instanced entity, which share `expressId` but hold distinct
      // world-space positions (issue #1405). templateIndex+byteOffset uniquely
      // and stably identifies an occurrence within the instance buffers.
      const occurrenceKey = `${expressId}:inst:${o.templateIndex}:${o.byteOffset}`;
      // #2985: the same drill-to-source id a flat mesh carries, so a consumer of
      // these pieces is not worse off for the geometry having been instanced.
      const item = o.itemId !== undefined ? { geometryItemId: o.itemId } : {};
      out.push({ expressId, positions, normals, indices: tpl.indices, color, occurrenceKey, ...item });
    }
    return out.length > 0 ? out : undefined;
}
