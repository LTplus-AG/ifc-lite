/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

/** Lattice step: 2^-10 m. Power of two => exact f32 dequantization. */
export const QUANT_STEP = 1 / 1024;

/** Max quantizable extent per axis (u16 range × step). */
export const MAX_QUANT_EXTENT = 65535 * QUANT_STEP;

export const QUANT_BYTES_PER_VERTEX = 12;

export interface QuantizedVertexData {
  /** Interleaved 12-byte records (uint16x4 + uint32). */
  vertexData: ArrayBuffer;
  /** Lattice-aligned quantization origin (batch-origin-relative frame). */
  quantMin: [number, number, number];
  /** Lattice step (constant, exported for the uniform write). */
  step: number;
}

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
 * Quantize a 28-byte interleaved batch vertex buffer (pos f32x3 + normal
 * f32x3 + entityId u32, `strideFloats` = 7) into the 12-byte layout.
 * Returns null when any axis extent exceeds the u16 lattice range — the
 * caller keeps the f32 buffer then.
 */
export function quantizeInterleaved(
  vertexData: Float32Array,
  strideFloats: number,
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
  const qminX = Math.floor(minX / QUANT_STEP) * QUANT_STEP;
  const qminY = Math.floor(minY / QUANT_STEP) * QUANT_STEP;
  const qminZ = Math.floor(minZ / QUANT_STEP) * QUANT_STEP;
  if (
    (maxX - qminX) > MAX_QUANT_EXTENT ||
    (maxY - qminY) > MAX_QUANT_EXTENT ||
    (maxZ - qminZ) > MAX_QUANT_EXTENT
  ) {
    return null;
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
