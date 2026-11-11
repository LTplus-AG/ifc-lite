/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { QUANT_STEP, MAX_QUANT_EXTENT, QUANT_BYTES_PER_VERTEX, octEncode, MAX_COLLAPSED_AREA_FRACTION } from '@ifc-lite/geometry/gpu-records';
export { QUANT_STEP, MAX_QUANT_EXTENT, QUANT_BYTES_PER_VERTEX, octEncode, MAX_COLLAPSED_AREA_FRACTION }; // one definition, shared with the geometry workers

/**
 * 12-byte quantized vertices (issue #1682, phase 6).
 *
 * Layout (stride 12, matches the pipeline's quantized vertex state):
 *   @0  uint16x4  qx, qy, qz, packedOct   (WGSL reads vec4<u32>)
 *   @8  uint32    entityId                (same lane semantics as the 28B path)
 *
 * Positions quantize onto a GLOBAL LATTICE with step 2^-10 m (~0.98 mm),
 * each batch storing a lattice-ALIGNED `quantMin` (a multiple of the step in
 * the shared batch-origin-relative frame). This is what preserves the
 * renderer's coincidence guarantee (see mergeGeometry's shared-origin note):
 * a world point shared by two batches quantizes to the same lattice node in
 * both, and the shader's `quantMin + q * step` is BIT-EXACT in f32 —
 * every term is (integer)·2^-10 with the integer < 2^24 — so coincident
 * surfaces stay coincident and no seam z-fighting is introduced.
 *
 * Normals use octahedral encoding (2×u8 packed into the 4th u16): ~1.4°
 * worst-case error, invisible for BIM flat shading. The per-vertex entityId
 * lane (picking id + colour salt) is carried unchanged.
 *
 * A batch whose extent exceeds `MAX_QUANT_EXTENT` (u16 range × step ≈ 64 m)
 * cannot quantize and stays on the 28-byte f32 path — the caller checks
 * `quantizeInterleaved`'s null return.
 */

export interface QuantizedVertexData {
  /** Interleaved 12-byte records (uint16x4 + uint32). */
  vertexData: ArrayBuffer;
  /** Lattice-aligned quantization origin (batch-origin-relative frame). */
  quantMin: [number, number, number];
  /** Lattice step (constant, exported for the uniform write). */
  step: number;
}


/** Decode (for tests/CPU parity with the WGSL decode). */
export function octDecode(bx: number, by: number): [number, number, number] {
  const ox = (bx / 255) * 2 - 1;
  const oy = (by / 255) * 2 - 1;
  let nx = ox, ny = oy;
  const nz = 1 - Math.abs(ox) - Math.abs(oy);
  if (nz < 0) {
    const tx = (1 - Math.abs(oy)) * (nx >= 0 ? 1 : -1);
    const ty = (1 - Math.abs(ox)) * (ny >= 0 ? 1 : -1);
    nx = tx; ny = ty;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * A lattice origin shared by several encodes, so their records concatenate
 * into one batch (the streamed fragments of one bucket, see
 * scene-stream-assembly.ts). Any lattice-aligned origin at or below the data
 * decodes to the same exact positions: `quantMin` and `q·step` are both integer
 * multiples of 2^-10 (main.wgsl.ts), so only the u16 range constrains it.
 */
export interface LatticeFrame {
  /** Unset: the first encode picks one with equal headroom on both sides of its data. */
  min?: [number, number, number];
}

/**
 * Quantize a 28-byte interleaved batch vertex buffer (pos f32x3 + normal
 * f32x3 + entityId u32, `strideFloats` = 7) into the 12-byte layout.
 * Returns null when any axis extent exceeds the u16 lattice range — the
 * caller keeps the f32 buffer then. With `lattice`, the data is encoded
 * against its shared origin whenever it fits that origin's range, else against
 * its own (the result's `quantMin` says which).
 */
export function quantizeInterleaved(
  vertexData: Float32Array,
  strideFloats: number,
  lattice?: LatticeFrame,
): QuantizedVertexData | null {
  const vertexCount = (vertexData.length / strideFloats) | 0;
  if (vertexCount === 0) {
    return { vertexData: new ArrayBuffer(0), quantMin: [0, 0, 0], step: QUANT_STEP };
  }

  // Pass 1: bounds.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const b = v * strideFloats;
    const x = vertexData[b], y = vertexData[b + 1], z = vertexData[b + 2];
    // A single non-finite vertex disqualifies the batch: NaN would otherwise
    // slip past the min/max comparisons and quantize to the batch corner (a
    // spike). Falling back to f32 preserves the current NaN behaviour.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Lattice-align the origin DOWNWARD so every q stays >= 0.
  let qminX = Math.floor(minX / QUANT_STEP) * QUANT_STEP;
  let qminY = Math.floor(minY / QUANT_STEP) * QUANT_STEP;
  let qminZ = Math.floor(minZ / QUANT_STEP) * QUANT_STEP;
  if (
    (maxX - qminX) > MAX_QUANT_EXTENT ||
    (maxY - qminY) > MAX_QUANT_EXTENT ||
    (maxZ - qminZ) > MAX_QUANT_EXTENT
  ) {
    return null;
  }
  if (lattice) {
    // Centre the data in the u16 range, leaving room for later encodes on either side.
    const centred = (qmin: number, max: number): number =>
      qmin - Math.floor(Math.floor((MAX_QUANT_EXTENT - (max - qmin)) / QUANT_STEP) / 2) * QUANT_STEP;
    lattice.min ??= [centred(qminX, maxX), centred(qminY, maxY), centred(qminZ, maxZ)];
    const [px, py, pz] = lattice.min;
    if (px <= minX && py <= minY && pz <= minZ
      && maxX - px <= MAX_QUANT_EXTENT && maxY - py <= MAX_QUANT_EXTENT && maxZ - pz <= MAX_QUANT_EXTENT) {
      qminX = px; qminY = py; qminZ = pz;
    }
  }

  // Pass 2: encode.
  const out = new ArrayBuffer(vertexCount * QUANT_BYTES_PER_VERTEX);
  const u16 = new Uint16Array(out);
  const u32 = new Uint32Array(out);
  const srcIds = new Uint32Array(vertexData.buffer, vertexData.byteOffset, vertexData.length);
  for (let v = 0; v < vertexCount; v++) {
    const b = v * strideFloats;
    // Round to the nearest lattice node. Coincident inputs across batches
    // produce identical q relative to their (lattice-aligned) quantMin.
    const qx = Math.round((vertexData[b] - qminX) / QUANT_STEP);
    const qy = Math.round((vertexData[b + 1] - qminY) / QUANT_STEP);
    const qz = Math.round((vertexData[b + 2] - qminZ) / QUANT_STEP);
    const [ox, oy] = octEncode(vertexData[b + 3], vertexData[b + 4], vertexData[b + 5]);
    const w16 = v * 6; // 6 u16 per 12-byte record
    u16[w16] = Math.min(65535, Math.max(0, qx));
    u16[w16 + 1] = Math.min(65535, Math.max(0, qy));
    u16[w16 + 2] = Math.min(65535, Math.max(0, qz));
    u16[w16 + 3] = (ox << 8) | oy;
    u32[v * 3 + 2] = srcIds[b + 6]; // entityId lane, verbatim
  }

  return { vertexData: out, quantMin: [qminX, qminY, qminZ], step: QUANT_STEP };
}


/**
 * True when snapping a batch onto the lattice would visibly destroy shape:
 * some entity loses more than `MAX_COLLAPSED_AREA_FRACTION` of its triangle
 * area to triangles that become zero-area. Sub-millimetre slivers occur in
 * most models and stay quantized; small round members (Ø≈2 mm rods, railing
 * bars, thin pipes) collapse wholesale and must not (#9068).
 *
 * `quantMin` is lattice-aligned, so `round(p / QUANT_STEP)` is the node
 * `quantizeInterleaved` writes; the integer cross product is exact.
 */
export function latticeCollapsesGeometry(
  vertexData: Float32Array,
  strideFloats: number,
  indices: Uint32Array,
): boolean {
  const vertexCount = (vertexData.length / strideFloats) | 0;
  const ids = new Uint32Array(vertexData.buffer, vertexData.byteOffset, vertexData.length);
  const nodes = new Int32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    for (let axis = 0; axis < 3; axis++) nodes[v * 3 + axis] = Math.round(vertexData[v * strideFloats + axis] / QUANT_STEP);
  }
  // Merged batches keep each entity's triangles contiguous: accumulate a run,
  // judge it when the entity changes (an entity split across runs is summed).
  const totals = new Map<number, { area: number; collapsed: number }>();
  let runId = -1, runArea = 0, runCollapsed = 0;
  const flush = (): void => {
    if (runId < 0) return;
    const entry = totals.get(runId) ?? { area: 0, collapsed: 0 };
    entry.area += runArea; entry.collapsed += runCollapsed;
    totals.set(runId, entry);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const pa = a * strideFloats, pb = b * strideFloats, pc = c * strideFloats;
    const ux = vertexData[pb] - vertexData[pa], uy = vertexData[pb + 1] - vertexData[pa + 1], uz = vertexData[pb + 2] - vertexData[pa + 2];
    const vx = vertexData[pc] - vertexData[pa], vy = vertexData[pc + 1] - vertexData[pa + 1], vz = vertexData[pc + 2] - vertexData[pa + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(area > 0)) continue;
    const id = ids[pa + 6];
    if (id !== runId) { flush(); runId = id; runArea = 0; runCollapsed = 0; }
    runArea += area;
    const na = a * 3, nb = b * 3, nc = c * 3;
    const qux = nodes[nb] - nodes[na], quy = nodes[nb + 1] - nodes[na + 1], quz = nodes[nb + 2] - nodes[na + 2];
    const qvx = nodes[nc] - nodes[na], qvy = nodes[nc + 1] - nodes[na + 1], qvz = nodes[nc + 2] - nodes[na + 2];
    // Integer lattice offsets: every product is exact, so zero means collapsed.
    if (quy * qvz - quz * qvy === 0 && quz * qvx - qux * qvz === 0 && qux * qvy - quy * qvx === 0) runCollapsed += area;
  }
  flush();
  for (const { area, collapsed } of totals.values()) {
    if (collapsed > area * MAX_COLLAPSED_AREA_FRACTION) return true;
  }
  return false;
}
