/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-instancing render prep — CPU side.
 *
 * Turns a decoded IFNS shard (one per geometry batch — see
 * `processGeometryBatchInstanced` / `decodeInstancedShard`) into render-ready
 * templates: each unique geometry is uploaded ONCE as a vertex/index buffer, and
 * its occurrences become a per-instance buffer (`stepMode: 'instance'`) of
 * transform + entityId + colour, drawn with `drawIndexed(indexCount,
 * instanceCount)`.
 *
 * FRAME: the shard is in the producer-native IFC Z-up frame (templates carry a
 * local origin; per-instance transforms are native `rel_k`). The renderer draws
 * WebGL Y-up world space. We fold the SAME constant Z-up→Y-up swap that
 * `MeshDataJs::new` bakes into the flat path into each per-instance matrix:
 *
 *     instMat = SWAP · rel_k · T(origin_t)
 *
 * applied to the template's LOCAL vertex `p_t` (stored relative to `origin_t`),
 * so `instMat · p_t = swap(rel_k · (origin_t + p_t)) = swap(origin_k + p_k)` —
 * exactly the world coordinate the flat path produces for occurrence k. Because
 * the swap is linear and the native-frame recomposition is already verified in
 * Rust (`verify_recomposition`), this lands instanced + flat geometry in one
 * frame. (See instanced-render.test.ts for the GPU-free proof.)
 *
 * PRECISION: the per-instance matrix is f32, so its translation jitters at
 * national-grid magnitudes (the f32-collapse the local-frame work targets). Fine
 * for building-local models; an IFNS v2 with an f64 per-instance origin is the
 * path for georef-scale.
 */

import { MathUtils } from './math.js';
import { OPAQUE_ALPHA_CUTOFF } from './overlay-routing.js';
import type { Mat4 } from './types.js';
import type { DecodedInstancedShard, DecodedInstance } from '@ifc-lite/geometry';

/**
 * Constant IFC Z-up → WebGL Y-up swap `(x, y, z) → (x, z, -y)`, column-major
 * (MathUtils / WGSL convention). Identical to the swap `MeshDataJs::new` applies
 * to the flat path, so instanced geometry shares the flat frame exactly.
 */
export const SWAP_ZUP_TO_YUP: Mat4 = {
  // column c, row r at index c*4+r:
  //   out.x = x, out.y = z, out.z = -y
  m: new Float32Array([
    1, 0, 0, 0, // col0 → (x, 0, 0)
    0, 0, -1, 0, // col1 → (0, 0, -y)
    0, 1, 0, 0, // col2 → (0, z, 0)
    0, 0, 0, 1, // col3 (translation)
  ]),
};

/**
 * Bytes per instance in the GPU instance buffer:
 *   [0..63]  mat4 (16 f32, column-major)
 *   [64..67] entityId (u32)
 *   [68..83] rgba (4 f32)
 *   [84..87] flags (u32 — bit 0 = selected; bit 1 = hidden)
 */
export const INSTANCE_STRIDE_BYTES = 88;

/** Byte offset of the rgba colour within an instance record (patched by lens/IDS overlays). */
export const INSTANCE_COLOR_OFFSET = 68;
/** Byte offset of the flags u32 within an instance record (patched by selection/visibility). */
export const INSTANCE_FLAGS_OFFSET = 84;
/** flags bit 0 — this occurrence is selected (blue highlight in the shader). */
export const INSTANCE_FLAG_SELECTED = 1;
/** flags bit 1 — this occurrence is hidden (hide/isolate); the shader discards it
 *  in both the render and pick passes so it neither draws nor is pickable. */
export const INSTANCE_FLAG_HIDDEN = 2;

/** Transpose a row-major mat4 (the IFNS / `DecodedInstance.transform` convention)
 *  into a column-major `Mat4` (MathUtils / WGSL convention). */
function rowMajorToColMajor(rm: Float32Array): Mat4 {
  const m = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      m[c * 4 + r] = rm[r * 4 + c];
    }
  }
  return { m };
}

/**
 * Compose the per-occurrence render matrix `SWAP · rel_k · T(origin)` that maps a
 * template's LOCAL vertex (relative to `origin`, native IFC frame) into WebGL
 * Y-up world space. Returns a column-major 16-float array; the renderer feeds its
 * four columns as vec4 vertex attributes (@location 3..6) and the shader computes
 * `worldPos = instMat * vec4(position, 1.0)`.
 */
export function composeInstanceMatrix(
  transformRowMajor: Float32Array,
  origin: readonly [number, number, number],
): Float32Array {
  const relK = rowMajorToColMajor(transformRowMajor);
  const t = MathUtils.identity();
  t.m[12] = origin[0];
  t.m[13] = origin[1];
  t.m[14] = origin[2];
  // SWAP · (rel_k · T(origin))
  const instMat = MathUtils.multiply(SWAP_ZUP_TO_YUP, MathUtils.multiply(relK, t));
  return instMat.m;
}

/** A unique template + the interleaved per-instance buffer for its occurrences. */
export interface InstancedRenderTemplate {
  /** Index of this template within its source shard (diagnostic only). */
  templateIndex: number;
  /** Template geometry, LOCAL to `origin`, native IFC frame (uploaded once). */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Template local origin (f64), folded into each instance matrix. */
  origin: [number, number, number];
  /** Interleaved instance data: per occurrence mat4(64B) + entityId(4B) + rgba(16B) + flags(4B). */
  instanceBuffer: ArrayBuffer;
  /** Number of occurrences (the `instanceCount` for drawIndexed). */
  instanceCount: number;
  /** Per-occurrence express ids, in buffer order (occurrence i is at byte i*stride).
   *  Lets the Scene build an express_id → occurrence map for per-instance
   *  selection-flag + colour-override patching. */
  entityIds: Uint32Array;
}

/**
 * Write one occurrence's interleaved record (mat4 column-major + entityId + rgba)
 * into `dv` at `byteOffset`. Little-endian to match the GPU buffer + the IFNS
 * decoder. Exposed for the unit test.
 */
export function writeInstanceRecord(
  dv: DataView,
  byteOffset: number,
  instanceMatrix: Float32Array,
  entityId: number,
  color: readonly [number, number, number, number],
  flags = 0,
): void {
  for (let j = 0; j < 16; j++) {
    dv.setFloat32(byteOffset + j * 4, instanceMatrix[j], true);
  }
  dv.setUint32(byteOffset + 64, entityId >>> 0, true);
  for (let j = 0; j < 4; j++) {
    dv.setFloat32(byteOffset + INSTANCE_COLOR_OFFSET + j * 4, color[j], true);
  }
  dv.setUint32(byteOffset + INSTANCE_FLAGS_OFFSET, flags >>> 0, true);
}

/**
 * Turn a decoded IFNS shard into render-ready templates. Each template's
 * occurrences are grouped and their `SWAP · rel_k · T(origin)` matrices +
 * entityId + colour packed into one interleaved instance buffer. Templates with
 * zero occurrences are skipped (encode always emits ≥1, but be defensive).
 *
 * TRANSPARENT instances (colour alpha < OPAQUE_ALPHA_CUTOFF — glass, IfcSpace,
 * openings) are EXCLUDED: the instanced pipeline is the opaque clone (no alpha
 * blend, depth-write on), so drawing glass here renders it opaque (and fs_main's
 * glass-fresnel tints it near-white). They render correctly via the flat
 * transparent pipeline instead — which the emit-both path still produces. Uses
 * the SAME 0.99 cutoff as the flat opaque/transparent split (overlay-routing.ts).
 */
export function prepareInstancedRender(shard: DecodedInstancedShard): InstancedRenderTemplate[] {
  const byTemplate: DecodedInstance[][] = shard.templates.map(() => []);
  for (const inst of shard.instances) {
    // Glass/transparent → flat transparent pipeline, not the opaque instanced one.
    if (inst.color[3] < OPAQUE_ALPHA_CUTOFF) continue;
    const bucket = byTemplate[inst.templateIndex];
    // Defensive: a corrupt templateIndex would otherwise throw; drop it loudly-safe.
    if (bucket) bucket.push(inst);
  }

  const out: InstancedRenderTemplate[] = [];
  for (let t = 0; t < shard.templates.length; t++) {
    const tmpl = shard.templates[t];
    const insts = byTemplate[t];
    if (!insts || insts.length === 0) continue;

    const buffer = new ArrayBuffer(insts.length * INSTANCE_STRIDE_BYTES);
    const dv = new DataView(buffer);
    const entityIds = new Uint32Array(insts.length);
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      const mat = composeInstanceMatrix(inst.transform, tmpl.origin);
      // flags = 0: every occurrence starts unselected.
      writeInstanceRecord(dv, i * INSTANCE_STRIDE_BYTES, mat, inst.entityId, inst.color, 0);
      entityIds[i] = inst.entityId >>> 0;
    }

    out.push({
      templateIndex: t,
      positions: tmpl.positions,
      normals: tmpl.normals,
      indices: tmpl.indices,
      origin: tmpl.origin,
      instanceBuffer: buffer,
      instanceCount: insts.length,
      entityIds,
    });
  }
  return out;
}
