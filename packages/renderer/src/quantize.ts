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

/** Share of one entity's surface that may collapse on the lattice before its batch stays f32 (#9068). */
export const MAX_COLLAPSED_AREA_FRACTION = 0.01;

/**
 * Share of one entity's surface whose face may flip or turn past 20°
 * (`MIN_LATTICE_COS2`) without collapsing before its batch stays f32 (#11444).
 * The shader shades a face by its snapped normal, so a turned face reads as
 * another surface. A Ø12 mm rebar collapses nothing on the ~1 mm lattice but
 * turns at least 10% of its area past 20° wherever it sits; chamfered everyday
 * pieces turn up to about 4%, which stays quantized.
 */
const MAX_TURNED_AREA_FRACTION = 0.05;
/** cos² of the 20° turn `MAX_TURNED_AREA_FRACTION` counts (the wasm encoder's `MIN_LATTICE_COS2`). */
const MIN_LATTICE_COS2 = Math.cos((20 * Math.PI) / 180) ** 2;

/** Source area (as `|n|`) of some triangles, and how much of it the lattice collapses, or keeps but turns. */
export interface LatticeLoss { area: number; collapsed: number; turned: number }

export function emptyLatticeLoss(): LatticeLoss {
  return { area: 0, collapsed: 0, turned: 0 };
}

/** Whether the lattice visibly destroys the shape `loss` sums up: the batch gate's rule for one entity. */
export function latticeLoses(loss: LatticeLoss): boolean {
  return loss.collapsed > loss.area * MAX_COLLAPSED_AREA_FRACTION || loss.turned > loss.area * MAX_TURNED_AREA_FRACTION;
}

/** Each vertex's lattice node, `round(p / QUANT_STEP)` per axis, from positions at `strideFloats`; into `nodes` when given (at least 3 per vertex). */
export function latticeNodes(vertexData: Float32Array, strideFloats: number, nodes?: Int32Array): Int32Array {
  const vertexCount = (vertexData.length / strideFloats) | 0;
  nodes ??= new Int32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    for (let axis = 0; axis < 3; axis++) nodes[v * 3 + axis] = Math.round(vertexData[v * strideFloats + axis] / QUANT_STEP);
  }
  return nodes;
}

/**
 * Add triangle `a, b, c` to `loss`: its source `|n|`, and that again under
 * `collapsed` and `turned` when its lattice nodes lose the face. A degenerate
 * source triangle adds nothing.
 */
export function addLatticeTriangle(
  loss: LatticeLoss, vertexData: Float32Array, strideFloats: number, nodes: Int32Array, a: number, b: number, c: number,
): void {
  const pa = a * strideFloats, pb = b * strideFloats, pc = c * strideFloats;
  const ux = vertexData[pb] - vertexData[pa], uy = vertexData[pb + 1] - vertexData[pa + 1], uz = vertexData[pb + 2] - vertexData[pa + 2];
  const vx = vertexData[pc] - vertexData[pa], vy = vertexData[pc + 1] - vertexData[pa + 1], vz = vertexData[pc + 2] - vertexData[pa + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(area > 0)) return;
  loss.area += area;
  const na = a * 3, nb = b * 3, nc = c * 3;
  const qux = nodes[nb] - nodes[na], quy = nodes[nb + 1] - nodes[na + 1], quz = nodes[nb + 2] - nodes[na + 2];
  const qvx = nodes[nc] - nodes[na], qvy = nodes[nc + 1] - nodes[na + 1], qvz = nodes[nc + 2] - nodes[na + 2];
  // Integer lattice offsets: every product is exact, so zero means collapsed.
  const qnx = quy * qvz - quz * qvy, qny = quz * qvx - qux * qvz, qnz = qux * qvy - quy * qvx;
  const qnSq = qnx * qnx + qny * qny + qnz * qnz;
  if (qnSq === 0) { loss.collapsed += area; return; }
  const turn = nx * qnx + ny * qny + nz * qnz;
  if (turn <= 0 || turn * turn < MIN_LATTICE_COS2 * area * area * qnSq) loss.turned += area;
}

/**
 * True when snapping a batch onto the lattice would visibly destroy shape:
 * some entity loses more than `MAX_COLLAPSED_AREA_FRACTION` of its triangle
 * area to triangles that become zero-area, or more than
 * `MAX_TURNED_AREA_FRACTION` to faces that turn past 20°. Sub-millimetre
 * slivers and small chamfers occur in most models and stay quantized; small
 * round members (Ø≈2 mm rods, railing bars, thin pipes, rebar) collapse or
 * crumple wholesale and must not (#9068, #11444). Scene routing keeps such
 * entities in buckets of their own (`markOffLattice`), so this mostly confirms
 * what routing decided.
 *
 * `quantMin` is lattice-aligned, so `round(p / QUANT_STEP)` is the node
 * `quantizeInterleaved` writes; the integer cross product is exact.
 */
export function latticeCollapsesGeometry(
  vertexData: Float32Array,
  strideFloats: number,
  indices: Uint32Array,
): boolean {
  const ids = new Uint32Array(vertexData.buffer, vertexData.byteOffset, vertexData.length);
  const nodes = latticeNodes(vertexData, strideFloats);
  // Merged batches keep each entity's triangles contiguous: switch totals when
  // the entity changes (an entity split across runs is summed).
  const totals = new Map<number, LatticeLoss>();
  let runId = -1;
  let run = emptyLatticeLoss();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const id = ids[indices[t] * strideFloats + 6];
    if (id !== runId) {
      runId = id;
      run = totals.get(id) ?? emptyLatticeLoss();
      totals.set(id, run);
    }
    addLatticeTriangle(run, vertexData, strideFloats, nodes, indices[t], indices[t + 1], indices[t + 2]);
  }
  for (const loss of totals.values()) {
    if (latticeLoses(loss)) return true;
  }
  return false;
}
