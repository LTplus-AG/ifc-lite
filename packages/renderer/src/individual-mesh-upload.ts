/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU upload of ONE individual mesh piece in its source batch's frame, shared
 * by selection hydration (`Renderer.createMeshFromData`) and the hover
 * pre-highlight cache (`hover-mesh-cache.ts`, #5390) so both draw geometry
 * bit-coincident with the batch they duplicate. Extracted from `index.ts`.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { MathUtils } from './math.js';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
import type { Mat4 } from './types.js';

const MAX_ENCODED_ENTITY_ID = 0xFFFFFF;
let warnedEntityIdRange = false;

/** Where the piece's source batch keeps its geometry. */
export interface IndividualMeshFrame {
  /** The batch's shared frame origin, or null when the batch has none. */
  sharedOrigin: readonly [number, number, number] | null;
  /** Whether the source batch renders lattice-snapped (quantized) positions. */
  quantized: boolean;
}

export interface IndividualMeshGpu {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  transform: Mat4;
  rteOrigin: [number, number, number];
}

export function uploadIndividualMesh(device: GPUDevice, meshData: MeshData, frame: IndividualMeshFrame): IndividualMeshGpu {
  const vertexCount = meshData.positions.length / 3;
  const interleavedRaw = new ArrayBuffer(vertexCount * 7 * 4);
  const interleaved = new Float32Array(interleavedRaw);
  const interleavedU32 = new Uint32Array(interleavedRaw);

  // Build this individual mesh (selection highlight + GPU object-id picker)
  // in the same small local frame as its source batch.
  // CRITICAL: replicate the BATCH's exact two-step f32 path so the highlight
  // is bit-coincident with its source surface (no z-fight, no depth bias):
  //   batch stores  s = f32(local + (origin - sharedOrigin))   [merge]
  //   batch shader  RTE = sharedOrigin - eye + s               [draw]
  // We retain `s` and the canonical origin separately. When there is no
  // shared origin, retain the piece origin instead of folding it in.
  const o = meshData.origin;
  const so = frame.sharedOrigin;
  const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
  const fr = Math.fround;
  const dx = so ? (ox - so[0]) : ox, dy = so ? (oy - so[1]) : oy, dz = so ? (oz - so[2]) : oz;
  // Quantized batches (issue #1682 phase 6) render lattice-snapped
  // positions: the shader's quantMin + q*step is exactly the lattice
  // node nearest the batch's stored f32 rel coordinate. Reproduce it by
  // snapping the SAME rel coordinate here (round(s*1024)/1024 in f64
  // yields the identical exact-f32 lattice value — see quantize.ts), so
  // the highlight/picker mesh stays BIT-coincident with its quantized
  // source surface, exactly as the two-step fold above achieves for the
  // f32 path. Meshes whose batch fell back to f32 must not snap.
  const snap = frame.quantized
    ? (v: number) => Math.round(v * 1024) / 1024
    : (v: number) => v;
  const p = meshData.positions;
  for (let i = 0; i < vertexCount; i++) {
    const base = i * 7;
    const posBase = i * 3;
    interleaved[base] = so ? snap(fr(p[posBase] + dx)) : snap(p[posBase]);
    interleaved[base + 1] = so ? snap(fr(p[posBase + 1] + dy)) : snap(p[posBase + 1]);
    interleaved[base + 2] = so ? snap(fr(p[posBase + 2] + dz)) : snap(p[posBase + 2]);
    const hasNormals = meshData.normals.length > 0;
    interleaved[base + 3] = hasNormals ? meshData.normals[posBase] : 0;
    interleaved[base + 4] = hasNormals ? meshData.normals[posBase + 1] : 0;
    interleaved[base + 5] = hasNormals ? meshData.normals[posBase + 2] : 0;
    let encodedId = meshData.expressId >>> 0;
    if (encodedId > MAX_ENCODED_ENTITY_ID) {
      if (!warnedEntityIdRange) {
        warnedEntityIdRange = true;
        console.warn('[Renderer] expressId exceeds 24-bit seam-ID encoding range; seam lines may collide.');
      }
      encodedId = encodedId & MAX_ENCODED_ENTITY_ID;
    }
    // Stamp the SAME high-byte material-colour salt as the batch path
    // (mergeGeometry) so this individual/selection mesh computes the
    // identical depth nudge as its source batch — otherwise the highlight
    // (selection pipeline, reverse-Z 'greater-equal') would z-fight or drop
    // out against the salted base depth. Low 24 bits stay the picking id.
    interleavedU32[base + 6] = packEntityLane(encodedId, colorSaltByte(meshData.color));
  }

  const vertexBuffer = device.createBuffer({
    size: interleaved.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, interleaved);

  const indexBuffer = device.createBuffer({
    size: meshData.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, meshData.indices);

  const transform = MathUtils.identity();
  transform.m[12] = so ? so[0] : ox;
  transform.m[13] = so ? so[1] : oy;
  transform.m[14] = so ? so[2] : oz;
  return {
    vertexBuffer,
    indexBuffer,
    indexCount: meshData.indices.length,
    transform,
    rteOrigin: so ? [so[0], so[1], so[2]] : [ox, oy, oz],
  };
}
