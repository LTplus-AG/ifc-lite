/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU vertex records for one mesh, the bytes the renderer's quantized batch
 * layout holds for it, computable wherever the mesh is (a geometry worker, or
 * the main thread). The renderer imports its lattice, normal, colour-salt and
 * entity-lane primitives from here, so there is one definition of each.
 *
 * Record (12 B): u16x3 lattice offsets from a lattice-aligned origin at step
 * 2^-10, oct-encoded normal (u8x2), u32 entity lane (id | colour salt << 24).
 */
import type { MeshData } from './types.js';

/** Lattice step: 2^-10 m. Power of two => exact f32 dequantization. */
export const QUANT_STEP = 1 / 1024;
/** Max quantizable extent per axis (u16 range × step). */
export const MAX_QUANT_EXTENT = 65535 * QUANT_STEP;
export const QUANT_BYTES_PER_VERTEX = 12;
/** Share of one entity's surface that may collapse on the lattice before its batch stays f32 (#9068). */
export const MAX_COLLAPSED_AREA_FRACTION = 0.01;

/** Octahedral-encode a unit normal into two bytes (0..255 each). */
export function octEncode(nx: number, ny: number, nz: number): [number, number] {
  const l1 = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  let ox: number, oy: number;
  if (l1 < 1e-12) {
    ox = 0; oy = 0;
  } else {
    ox = nx / l1;
    oy = ny / l1;
    if (nz < 0) {
      const tx = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
      const ty = (1 - Math.abs(ox)) * (oy >= 0 ? 1 : -1);
      ox = tx; oy = ty;
    }
  }
  // [-1,1] -> [0,255]
  const bx = Math.max(0, Math.min(255, Math.round((ox * 0.5 + 0.5) * 255)));
  const by = Math.max(0, Math.min(255, Math.round((oy * 0.5 + 0.5) * 255)));
  return [bx, by];
}

/**
 * Per-vertex z-nudge salt.
 *
 * The anti-z-fight depth nudge in `main.wgsl.ts` must produce the SAME depth for
 * a given surface in every draw of it: its batch, a partial sub-batch drawn
 * instead of it, and the selection highlight (`greater-equal`) drawn over it.
 * (It was introduced for the equal-depth colour-overlay pass, retired in #6076.)
 *
 * Material-layer slices share their parent's expressId, so the nudge can't
 * separate their coincident coplanar caps from the id alone — it needs the
 * material colour. We bake an 8-bit hash of `MeshData.color` into the HIGH 8
 * bits of the per-vertex entityId lane (the low 24 bits stay the picking id;
 * `encodeId24` masks the salt off). Because the salt comes from the geometry's
 * OWN colour — not the per-draw `baseColor` uniform — every redraw computes an
 * identical nudge, while distinct layers still separate.
 *
 * Returns a byte in [0,255]. Stamp it as `(id & 0x00FFFFFF) | (salt << 24)`.
 */
export function colorSaltByte(color?: readonly number[] | null): number {
  if (!color) return 0;
  const r = (Math.round((color[0] ?? 0) * 255) & 0xFF) >>> 0;
  const g = (Math.round((color[1] ?? 0) * 255) & 0xFF) >>> 0;
  const b = (Math.round((color[2] ?? 0) * 255) & 0xFF) >>> 0;
  // Same Knuth-style mix #1160 used (folded to 8 bits — the zHash is `& 255`
  // anyway, so a byte carries all the entropy that survives downstream).
  const h = (Math.imul(r, 73856093) ^ Math.imul(g, 19349663) ^ Math.imul(b, 83492791)) >>> 0;
  return h & 0xFF;
}

/** Stamp the colour salt into the high 8 bits, picking id into the low 24. */
export function packEntityLane(rawId: number, saltByte: number): number {
  return (((rawId >>> 0) & 0x00FFFFFF) | ((saltByte & 0xFF) << 24)) >>> 0;
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

/**
 * One mesh's GPU records in a model frame against a bucket's lattice origin,
 * with what a batch built from it needs besides the bytes.
 */
export interface MeshRecords {
  frame: readonly [number, number, number];
  pin: readonly [number, number, number];
  /** One 12-byte record per vertex. */
  records: ArrayBuffer;
  /** World bounds (`origin + position`, f64): what the batch merge reports. */
  worldMin: [number, number, number];
  worldMax: [number, number, number];
  /**
   * #9068 inputs: `[lane, area, collapsedArea]` per run of consecutive
   * triangles with one entity lane, in triangle order. Summed per lane over a
   * batch, they decide whether it may quantize (`batchCollapseVerdict`).
   */
  collapseRuns: Float64Array;
}

/**
 * The records `mergeGeometry(…, frame)` followed by `quantizeInterleaved` with
 * the lattice origin `pin` writes for `mesh`, the same bytes, or `null` when
 * that batch would not take them as they are: a triangle collapses in f32 in
 * this frame (#6515), a position is not finite, or a vertex lies outside the
 * u16 range above `pin`. `pin` must be on the 2^-10 lattice.
 *
 * Per vertex, as the merge and the quantizer do it: `rel = f32(position +
 * (origin - frame))`, `q = round((rel - pin) / step)`, the oct-encoded f32
 * normal, and `packEntityLane(id, colorSaltByte(color))`.
 */
export function encodeMeshRecords(
  mesh: MeshData,
  frame: readonly [number, number, number],
  pin: readonly [number, number, number],
): MeshRecords | null {
  if (!originPreservesTriangleTopology([mesh], frame)) return null;
  const p = mesh.positions, n = mesh.normals, count = (p.length / 3) | 0;
  const o = mesh.origin;
  const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
  const delta = [ox - frame[0], oy - frame[1], oz - frame[2]];
  const rel = new Float32Array(count * 3);
  const worldMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const worldMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    for (let axis = 0; axis < 3; axis++) {
      const at = v * 3 + axis;
      const value = (rel[at] = p[at] + delta[axis]);
      if (!Number.isFinite(value) || value < pin[axis] || value - pin[axis] > MAX_QUANT_EXTENT) return null;
      const world = p[at] + (axis === 0 ? ox : axis === 1 ? oy : oz);
      if (world < worldMin[axis]) worldMin[axis] = world;
      if (world > worldMax[axis]) worldMax[axis] = world;
    }
  }
  const records = new ArrayBuffer(count * QUANT_BYTES_PER_VERTEX);
  const u16 = new Uint16Array(records), u32 = new Uint32Array(records);
  const lanes = new Uint32Array(count);
  const salt = colorSaltByte(mesh.color);
  const ids = mesh.entityIds, id = mesh.expressId >>> 0, hasNormals = n.length > 0;
  for (let v = 0; v < count; v++) {
    const b = v * 3;
    const w16 = v * 6;
    for (let axis = 0; axis < 3; axis++) u16[w16 + axis] = Math.min(65535, Math.max(0, Math.round((rel[b + axis] - pin[axis]) / QUANT_STEP)));
    const [ex, ey] = hasNormals ? octEncode(n[b], n[b + 1], n[b + 2]) : octEncode(0, 0, 0);
    u16[w16 + 3] = (ex << 8) | ey;
    u32[v * 3 + 2] = lanes[v] = packEntityLane(ids ? ids[v] : id, salt);
  }
  return { frame, pin, records, worldMin, worldMax, collapseRuns: collapseRunsOf(rel, lanes, mesh.indices) };
}

/** `latticeCollapsesGeometry`'s per-triangle arithmetic over one mesh's frame-relative f32 positions, as runs. */
function collapseRunsOf(rel: Float32Array, lanes: Uint32Array, indices: Uint32Array): Float64Array {
  const runs: number[] = [];
  let runId = -1, runArea = 0, runCollapsed = 0;
  const node = (v: number, axis: number) => Math.round(rel[v * 3 + axis] / QUANT_STEP);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ux = rel[b * 3] - rel[a * 3], uy = rel[b * 3 + 1] - rel[a * 3 + 1], uz = rel[b * 3 + 2] - rel[a * 3 + 2];
    const vx = rel[c * 3] - rel[a * 3], vy = rel[c * 3 + 1] - rel[a * 3 + 1], vz = rel[c * 3 + 2] - rel[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(area > 0)) continue;
    const lane = lanes[a];
    if (lane !== runId) {
      if (runId >= 0) runs.push(runId, runArea, runCollapsed);
      runId = lane; runArea = 0; runCollapsed = 0;
    }
    runArea += area;
    const qux = node(b, 0) - node(a, 0), quy = node(b, 1) - node(a, 1), quz = node(b, 2) - node(a, 2);
    const qvx = node(c, 0) - node(a, 0), qvy = node(c, 1) - node(a, 1), qvz = node(c, 2) - node(a, 2);
    if (quy * qvz - quz * qvy === 0 && quz * qvx - qux * qvz === 0 && qux * qvy - quy * qvx === 0) runCollapsed += area;
  }
  if (runId >= 0) runs.push(runId, runArea, runCollapsed);
  return Float64Array.from(runs);
}

/**
 * Whether a batch of these meshes may quantize (#9068), from their runs:
 * `'f32'` when some entity lane loses more than `MAX_COLLAPSED_AREA_FRACTION`
 * of its area, `'quantize'` when none does, and `'unsure'` when a lane sits
 * so close to the threshold that summing per mesh instead of per triangle
 * could round to the other side (the caller then runs the exact check).
 */
export function batchCollapseVerdict(meshes: readonly Pick<MeshRecords, 'collapseRuns'>[]): 'quantize' | 'f32' | 'unsure' {
  const totals = new Map<number, [number, number]>();
  for (const { collapseRuns: runs } of meshes) {
    for (let r = 0; r + 2 < runs.length; r += 3) {
      const entry = totals.get(runs[r]);
      if (entry) { entry[0] += runs[r + 1]; entry[1] += runs[r + 2]; } else totals.set(runs[r], [runs[r + 1], runs[r + 2]]);
    }
  }
  let unsure = false;
  for (const [area, collapsed] of totals.values()) {
    const limit = area * MAX_COLLAPSED_AREA_FRACTION;
    if (Math.abs(collapsed - limit) <= area * 1e-9) unsure = true;
    else if (collapsed > limit) return 'f32';
  }
  return unsure ? 'unsure' : 'quantize';
}
