/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a bucket batch would stay exact f32 (#9068), judged from compact records.
 *
 * The bucket path keeps a whole batch f32 when one ENTITY in it would lose more than
 * `maxCollapsedFraction` of its area to triangles the 2^-10 lattice collapses, summed over all
 * of that entity's pieces in the batch (quantize.ts `latticeCollapsesGeometry`). The encoder
 * judges each MESH alone and moves one that collapses to a finer level. So only an entity with a
 * finer-level row can tip its batch, and it does only when its collapsed area, over all its meshes
 * in the group, passes the threshold. Areas come from the records: a finer row is within its own
 * (smaller) step of the source; a level 10 row lost the triangles welding emptied, which the encoder
 * already bounded by the same threshold per mesh.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { COMPACT_RECORD_BYTES, compactRow, compactStep } from '@ifc-lite/geometry/compact';

/** World positions of a row's records, absolute. */
function positionsOf(mesh: MeshData): Float64Array {
  const ref = mesh.compact!, { vertexStart, vertexCount, level } = compactRow(ref);
  const step = compactStep(level), w = ref.payload.windows, r = ref.row * 3, records = ref.payload.records;
  const view = new DataView(records.buffer, records.byteOffset + vertexStart * COMPACT_RECORD_BYTES, vertexCount * COMPACT_RECORD_BYTES);
  const out = new Float64Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    for (let axis = 0; axis < 3; axis++) out[v * 3 + axis] = (w[r + axis] + view.getUint16(v * COMPACT_RECORD_BYTES + axis * 2, true)) * step;
  }
  return out;
}

/** Total and lattice-collapsed triangle area of `mesh`, nodes on the `quantStep` lattice. */
function collapsedArea(mesh: MeshData, quantStep: number): { area: number; collapsed: number } {
  const p = positionsOf(mesh), ref = mesh.compact!, { indexStart, indexCount } = compactRow(ref), src = ref.payload.indices;
  let area = 0, collapsed = 0;
  for (let t = 0; t < indexCount; t += 3) {
    const a = src[indexStart + t] * 3, b = src[indexStart + t + 1] * 3, c = src[indexStart + t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const s = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(s > 0)) continue;
    area += s;
    const node = (i: number): number => Math.round(p[i] / quantStep);
    const qux = node(b) - node(a), quy = node(b + 1) - node(a + 1), quz = node(b + 2) - node(a + 2);
    const qvx = node(c) - node(a), qvy = node(c + 1) - node(a + 1), qvz = node(c + 2) - node(a + 2);
    if (quy * qvz - quz * qvy === 0 && quz * qvx - qux * qvz === 0 && qux * qvy - quy * qvx === 0) collapsed += s;
  }
  return { area, collapsed };
}

/**
 * Whether the bucket batch holding `members` would stay f32 because one of its entities collapses:
 * only entities with a row finer than `quantStep` are judged (each other mesh collapsed at most
 * `maxCollapsedFraction` of its own area, so its entity cannot pass it).
 */
export function entityCollapses(members: readonly MeshData[], quantStep: number, maxCollapsedFraction: number): boolean {
  const fine = new Set<number>();
  for (const mesh of members) if (compactStep(compactRow(mesh.compact!).level) < quantStep) fine.add(mesh.expressId);
  if (fine.size === 0) return false;
  const totals = new Map<number, { area: number; collapsed: number }>();
  for (const mesh of members) {
    if (!fine.has(mesh.expressId)) continue;
    const { area, collapsed } = collapsedArea(mesh, quantStep);
    const total = totals.get(mesh.expressId) ?? { area: 0, collapsed: 0 };
    total.area += area; total.collapsed += collapsed;
    totals.set(mesh.expressId, total);
  }
  for (const { area, collapsed } of totals.values()) if (collapsed > area * maxCollapsedFraction) return true;
  return false;
}
