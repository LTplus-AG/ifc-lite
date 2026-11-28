/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { COMPACT_RECORD_BYTES, compactRow, compactStep } from '@ifc-lite/geometry/compact';
import type { CompactPageDeps } from './compact-page-deps.js';

/** A finer-level row can identify a thin solid or an entity at risk of area collapse.
 * Judge all pieces of each such entity together with the bucket's own guard (#9068, #11579).
 * Ordinary groups never allocate a scratch batch. */
export function entityCollapses(members: readonly MeshData[], quantStep: number, collapses: CompactPageDeps['bucket']['collapses']): boolean {
  const fine = new Set<number>();
  for (const mesh of members) if (compactStep(compactRow(mesh.compact!).level) < quantStep) fine.add(mesh.expressId);
  const pieces = members.filter(mesh => fine.has(mesh.expressId));
  if (!pieces.length) return false;
  const rows = pieces.map(mesh => compactRow(mesh.compact!));
  const counts = rows.map(row => row.vertexCount);
  const stride = 7; // XYZ and the bucket guard's entity lane at offset 6
  const vertices = new Float32Array(stride * counts.reduce((sum, n) => sum + n, 0));
  const lanes = new Uint32Array(vertices.buffer);
  const indices = new Uint32Array(rows.reduce((sum, row) => sum + row.indexCount, 0));
  const origin = [0, 0, 0];
  let base = 0, index = 0;
  for (const [i, mesh] of pieces.entries()) {
    const { vertexStart, vertexCount, indexStart, indexCount, level } = rows[i];
    const { payload, row } = mesh.compact!;
    const step = compactStep(level);
    const records = new DataView(payload.records.buffer, payload.records.byteOffset + vertexStart * COMPACT_RECORD_BYTES, vertexCount * COMPACT_RECORD_BYTES);
    for (let axis = 0; axis < 3; axis++) {
      const window = payload.windows[row * 3 + axis] * step;
      // Remove a lattice-aligned origin in f64 before narrowing survey coordinates to f32.
      if (i === 0) origin[axis] = Math.floor(window / quantStep) * quantStep;
      for (let v = 0; v < vertexCount; v++) {
        vertices[(base + v) * stride + axis] = window - origin[axis] + records.getUint16(v * COMPACT_RECORD_BYTES + axis * 2, true) * step;
      }
    }
    for (let v = 0; v < vertexCount; v++) lanes[(base + v) * stride + 6] = mesh.expressId;
    for (let t = 0; t < indexCount; t++) indices[index++] = base + payload.indices[indexStart + t];
    base += vertexCount;
  }
  return collapses(vertices, stride, indices, counts);
}
