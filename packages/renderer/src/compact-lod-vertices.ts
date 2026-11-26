/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The vertices a compact page's LOD1 triangles are drawn with (compact-lod.ts).
 *
 * A LOD1 triangle's corners are its cells' representatives. On the bucket path a representative is
 * one source corner of the unwelded soup: the one at the smallest position, then the smallest
 * NORMAL (lod-simplify.ts), so it carries that corner's own face normal. A page's records are
 * welded: the vertex at that position carries the SUM of its corners' normals. The fragment shader
 * orients each face by the sign of its interpolated vertex normal (main.wgsl.ts), so a LOD1 face
 * drawn over summed normals can be lit from the other side than the bucket's. The page therefore
 * draws LOD1 from records of its own: each representative's position and lane, and the smallest
 * face normal among the triangles that touch that position for that entity, as the bucket elects.
 */

import { COMPACT_RECORD_BYTES } from '@ifc-lite/geometry/compact';

/** The page-frame positions and lanes `buildPageLods` read into its scratch (4 floats per vertex, lane as u32 at 3). */
export interface PageScratch {
  positions: Float32Array;
  lanes: Uint32Array;
  vertexCount: number;
  /** The page's dequantization: position = min + q * step. */
  quantized: { min: readonly number[]; step: number };
}

const STRIDE = 4;

/** Whether normal (ax, ay, az) precedes (bx, by, bz) lexicographically (the bucket's election order). */
function precedes(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  if (ax !== bx) return ax < bx;
  if (ay !== by) return ay < by;
  return az < bz;
}

/**
 * The LOD1 vertices of one part: `lod1` (page vertex numbers, from the clustering over `source`) becomes
 * indices into `records`, one 12-byte record per distinct representative.
 */
export function lod1Vertices(
  lod1: Uint32Array, source: Uint32Array, page: PageScratch, octEncode: (x: number, y: number, z: number) => [number, number],
): { indices: Uint16Array; records: Uint8Array } {
  const { positions: p, lanes, quantized: q } = page;
  // The smallest face normal at each vertex, over the part's triangles (NaN: no face yet).
  const smallest = new Float32Array(page.vertexCount * 3).fill(Number.NaN);
  for (let t = 0; t + 2 < source.length; t += 3) {
    const a = source[t] * STRIDE, b = source[t + 1] * STRIDE, c = source[t + 2] * STRIDE;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) continue;
    nx /= length; ny /= length; nz /= length;
    for (let k = 0; k < 3; k++) {
      const v = source[t + k] * 3;
      if (Number.isNaN(smallest[v]) || precedes(nx, ny, nz, smallest[v], smallest[v + 1], smallest[v + 2])) {
        smallest[v] = nx; smallest[v + 1] = ny; smallest[v + 2] = nz;
      }
    }
  }
  // Welded vertices at one position and lane (other meshes of the entity, or sides kept apart) share their corners.
  const node = (v: number, axis: number): number => Math.round((p[v * STRIDE + axis] - q.min[axis]) / q.step);
  const positionKey = (v: number): number => (node(v, 0) * 65536 + node(v, 1)) * 65536 + node(v, 2);
  const local = new Map<number, number>(); // page vertex -> representative record
  const reps: number[] = [];
  for (let i = 0; i < lod1.length; i++) if (!local.has(lod1[i])) { local.set(lod1[i], reps.length); reps.push(lod1[i]); }
  const atPosition = new Map<number, number[]>();
  for (const rep of reps) atPosition.set(positionKey(rep), []);
  for (let t = 0; t < source.length; t++) {
    const list = atPosition.get(positionKey(source[t]));
    if (list && !list.includes(source[t])) list.push(source[t]);
  }
  const records = new Uint8Array(reps.length * COMPACT_RECORD_BYTES);
  const view = new DataView(records.buffer);
  reps.forEach((rep, r) => {
    let bx = Number.NaN, by = 0, bz = 0;
    for (const v of atPosition.get(positionKey(rep)) ?? [rep]) {
      if (lanes[v * STRIDE + 3] !== lanes[rep * STRIDE + 3] || Number.isNaN(smallest[v * 3])) continue;
      if (Number.isNaN(bx) || precedes(smallest[v * 3], smallest[v * 3 + 1], smallest[v * 3 + 2], bx, by, bz)) {
        bx = smallest[v * 3]; by = smallest[v * 3 + 1]; bz = smallest[v * 3 + 2];
      }
    }
    const [ox, oy] = Number.isNaN(bx) ? [0, 0] : octEncode(bx, by, bz);
    const at = r * COMPACT_RECORD_BYTES;
    for (let axis = 0; axis < 3; axis++) view.setUint16(at + axis * 2, node(rep, axis), true);
    view.setUint16(at + 6, (ox << 8) | oy, true);
    view.setUint32(at + 8, lanes[rep * STRIDE + 3], true);
  });
  const indices = new Uint16Array(lod1.length);
  for (let i = 0; i < lod1.length; i++) indices[i] = local.get(lod1[i])!;
  return { indices, records };
}
