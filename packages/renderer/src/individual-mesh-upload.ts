/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU upload of an entity's mesh pieces in their source batch's frame, shared
 * by selection hydration (`Renderer.createMeshFromData`) and the hover
 * pre-highlight cache (`hover-mesh-cache.ts`, #5390) so both draw geometry
 * bit-coincident with the batch they duplicate. Extracted from `index.ts`.
 *
 * An ordinary entity gets one mesh per piece. Above
 * {@link MERGE_PIECES_ABOVE} pieces that is the wrong shape: a mapped
 * SurfaceModel can hold 90k items, and three GPU buffers plus a bind group for
 * each one froze the UI and lost the device (#9192). Those pieces merge into
 * one mesh per colour and frame, the same partition the batches use.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { colorKey } from './chunk-grid.js';
import { BATCH_CONSTANTS } from './constants.js';
import { MathUtils } from './math.js';
import { MAX_PICK_MESH_CREATION } from './pick-mesh-budget.js';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
import type { Mat4 } from './types.js';

const MAX_ENCODED_ENTITY_ID = 0xFFFFFF;
const FLOATS_PER_VERTEX = BATCH_CONSTANTS.BYTES_PER_VERTEX / 4;
let warnedEntityIdRange = false;

/**
 * An entity with more pieces than this is copied merged. It shares the pick
 * budget because both name one limit, the individual buffers a single action
 * can afford, and because a pick never hydrates such an entity piece by piece.
 */
export const MERGE_PIECES_ABOVE = MAX_PICK_MESH_CREATION;

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

/** One GPU mesh standing for `pieces` same-coloured pieces of an entity. */
export interface MergedMeshGpu extends IndividualMeshGpu {
  /** The first piece merged: every piece here shares its colour, finish and model. */
  representative: MeshData;
  pieces: number;
}

/** Write one piece's vertices at `firstVertex` of a merged or single interleaved buffer. */
function writePieceVertices(interleaved: Float32Array, lanes: Uint32Array, firstVertex: number, meshData: MeshData, frame: IndividualMeshFrame): void {
  const vertexCount = meshData.positions.length / 3;
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
    const base = (firstVertex + i) * FLOATS_PER_VERTEX;
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
    lanes[base + 6] = packEntityLane(encodedId, colorSaltByte(meshData.color));
  }

}

/** Upload finished geometry, retaining the frame origin separately from the f32 vertices. */
function uploadGeometry(
  device: GPUDevice,
  interleaved: Float32Array,
  indices: Uint32Array,
  first: MeshData,
  frame: IndividualMeshFrame,
): IndividualMeshGpu {
  const so = frame.sharedOrigin;
  const o = first.origin;
  const origin: [number, number, number] = so ? [so[0], so[1], so[2]] : [o ? o[0] : 0, o ? o[1] : 0, o ? o[2] : 0];

  const vertexBuffer = device.createBuffer({
    size: interleaved.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  // Nothing allocated here outlives a throw: a caller freeing only what this
  // returned would otherwise leak the vertex buffer of the mesh that failed.
  let indexBuffer: GPUBuffer | undefined;
  try {
    device.queue.writeBuffer(vertexBuffer, 0, interleaved);
    indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, indices);
  } catch (error) {
    vertexBuffer.destroy();
    indexBuffer?.destroy();
    throw error;
  }

  const transform = MathUtils.identity();
  transform.m[12] = origin[0];
  transform.m[13] = origin[1];
  transform.m[14] = origin[2];
  return { vertexBuffer, indexBuffer, indexCount: indices.length, transform, rteOrigin: origin };
}

export function uploadIndividualMesh(device: GPUDevice, meshData: MeshData, frame: IndividualMeshFrame): IndividualMeshGpu {
  const interleavedRaw = new ArrayBuffer((meshData.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX);
  const interleaved = new Float32Array(interleavedRaw);
  writePieceVertices(interleaved, new Uint32Array(interleavedRaw), 0, meshData, frame);
  return uploadGeometry(device, interleaved, meshData.indices, meshData, frame);
}

interface MergeGroup {
  frame: IndividualMeshFrame;
  pieces: MeshData[];
  vertices: number;
  indices: number;
}

/**
 * Partition pieces so each group can draw as one mesh without changing what
 * any piece looks like: same model, same frame (the f32 fold is per frame, and
 * a frameless piece keeps its own origin), same colour and finish, as a batch
 * bucket has. A group fills up at `maxBytes`, one GPU buffer's worth.
 */
function groupPieces(pieces: readonly MeshData[], frameOf: (meshData: MeshData) => IndividualMeshFrame, maxBytes: number): MergeGroup[] {
  const groups: MergeGroup[] = [];
  const open = new Map<string, MergeGroup>();
  for (const piece of pieces) {
    const vertices = piece.positions.length / 3;
    const indices = piece.indices.length;
    if (vertices === 0 || indices === 0) continue;
    const frame = frameOf(piece);
    const origin = frame.sharedOrigin ?? piece.origin;
    const key = `${piece.modelIndex ?? ''}|${frame.quantized ? 'q' : 'f'}|${frame.sharedOrigin ? 's' : 'o'}|${origin?.join() ?? ''}|${colorKey(piece.color, piece.material)}`;
    let group = open.get(key);
    if (group && group.pieces.length > 0
      && ((group.vertices + vertices) * BATCH_CONSTANTS.BYTES_PER_VERTEX > maxBytes
        || (group.indices + indices) * BATCH_CONSTANTS.BYTES_PER_INDEX > maxBytes)) group = undefined;
    if (!group) {
      group = { frame, pieces: [], vertices: 0, indices: 0 };
      open.set(key, group);
      groups.push(group);
    }
    group.pieces.push(piece);
    group.vertices += vertices;
    group.indices += indices;
  }
  return groups;
}

/**
 * Upload an entity's pieces merged: one mesh per group, so the allocations and
 * draws scale with the entity's colours and frames, not its piece count. A
 * throw part-way frees what this call already created.
 */
export function uploadMergedMeshes(
  device: GPUDevice,
  pieces: readonly MeshData[],
  frameOf: (meshData: MeshData) => IndividualMeshFrame,
): MergedMeshGpu[] {
  const limit = Math.min(device.limits?.maxBufferSize ?? BATCH_CONSTANTS.FALLBACK_MAX_BUFFER_SIZE, BATCH_CONSTANTS.FALLBACK_MAX_BUFFER_SIZE);
  const maxBytes = Math.floor(limit * BATCH_CONSTANTS.BUFFER_SIZE_SAFETY_FACTOR);
  const uploaded: MergedMeshGpu[] = [];
  try {
    for (const group of groupPieces(pieces, frameOf, maxBytes)) {
      const interleavedRaw = new ArrayBuffer(group.vertices * BATCH_CONSTANTS.BYTES_PER_VERTEX);
      const interleaved = new Float32Array(interleavedRaw);
      const lanes = new Uint32Array(interleavedRaw);
      const indices = new Uint32Array(group.indices);
      let firstVertex = 0;
      let firstIndex = 0;
      for (const piece of group.pieces) {
        writePieceVertices(interleaved, lanes, firstVertex, piece, group.frame);
        const source = piece.indices;
        for (let i = 0; i < source.length; i++) indices[firstIndex + i] = source[i] + firstVertex;
        firstIndex += source.length;
        firstVertex += piece.positions.length / 3;
      }
      const representative = group.pieces[0];
      uploaded.push({ ...uploadGeometry(device, interleaved, indices, representative, group.frame), representative, pieces: group.pieces.length });
    }
  } catch (error) {
    for (const mesh of uploaded) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer.destroy();
    }
    throw error;
  }
  return uploaded;
}
