/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry merge utilities extracted from Scene.
 *
 * Pure functions that take mesh data arrays and return merged buffers.
 * No dependency on Scene internal state or GPU device.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { BATCH_CONSTANTS } from './constants.js';

const MAX_ENCODED_ENTITY_ID = 0xFFFFFF;
let warnedEntityIdRange = false;

/**
 * Per-vertex z-nudge salt (issue: lens/overlay colouring).
 *
 * The anti-z-fight depth nudge in `main.wgsl.ts` must produce the SAME depth for
 * a given surface in BOTH the base opaque pass and the lens/IDS/compare/4D
 * OVERLAY pass (the overlay pipeline uses `depthCompare: 'equal'`, so any depth
 * difference rejects every overlay fragment — colour silently fails to paint).
 *
 * Material-layer slices share their parent's expressId, so the nudge can't
 * separate their coincident coplanar caps from the id alone — it needs the
 * material colour. We bake an 8-bit hash of `MeshData.color` into the HIGH 8
 * bits of the per-vertex entityId lane (the low 24 bits stay the picking id;
 * `encodeId24` masks the salt off). Because the salt comes from the geometry's
 * OWN colour — not the per-draw `baseColor` uniform — the base and overlay
 * passes compute an identical nudge, while distinct layers still separate.
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

/**
 * Merge multiple mesh geometries into single interleaved vertex/index buffers.
 *
 * Layout per vertex: position (3f) + normal (3f) + entityId (1u32) = 7 × 4 bytes.
 * Bounds are tracked during the merge pass to avoid a second iteration.
 */
export function mergeGeometry(
  meshDataArray: MeshData[],
  // A SHARED scene origin used by EVERY batch. Passing the same origin to all
  // batches is what kills inter-batch seam z-fighting: a world point shared by
  // two abutting elements in different colour batches relativizes to the SAME
  // f32 value (stored = world - sharedOrigin) and draws with the SAME model
  // matrix (translate(sharedOrigin)), so the two surfaces land bit-coincident
  // instead of diverging by a few f32 ULP. When omitted (first batch / legacy),
  // the batch's own world bbox centre is used and returned so the caller can
  // pin it as the shared origin for all subsequent batches.
  forcedOrigin?: [number, number, number],
): {
  vertexData: Float32Array;
  indices: Uint32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** The local-frame origin actually used (forcedOrigin, or this batch's world
   *  bbox centre). Stored positions are RELATIVE to it; the renderer draws with
   *  model = translate(origin) so f32 vertex coords stay small. */
  origin: [number, number, number];
} {
  let totalVertices = 0;
  let totalIndices = 0;

  // Calculate total sizes
  for (const mesh of meshDataArray) {
    totalVertices += mesh.positions.length / 3;
    totalIndices += mesh.indices.length;
  }

  // Create merged buffers
  const vertexBufferRaw = new ArrayBuffer(totalVertices * 7 * 4);
  const vertexData = new Float32Array(vertexBufferRaw); // position + normal
  const vertexDataU32 = new Uint32Array(vertexBufferRaw); // entityId lane
  const indices = new Uint32Array(totalIndices);

  // Pre-pass: WORLD bounding box of the batch (world = mesh.origin + position).
  // batchOrigin = bbox centre; storing vertices relative to it keeps the f32
  // magnitudes small (≈ half the batch's spatial spread) regardless of the
  // model's world placement — which is what prevents f32 fan collapse. A mesh
  // without an origin contributes its absolute positions (legacy no-op shift).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshDataArray) {
    const p = mesh.positions;
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  // Prefer the caller's shared scene origin (consistent across all batches → no
  // seam z-fight); fall back to this batch's own world bbox centre.
  const batchOrigin: [number, number, number] = forcedOrigin
    ?? (Number.isFinite(minX)
      ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
      : [0, 0, 0]);

  let indexOffset = 0;
  let vertexBase = 0;

  for (const mesh of meshDataArray) {
    const positions = mesh.positions;
    const normals = mesh.normals;
    const vertexCount = positions.length / 3;
    // Shift this mesh into the batch-local frame: stored = world - batchOrigin
    // = (mesh.origin - batchOrigin) + localPosition. f64 fold, f32 store.
    const dox = (mesh.origin ? mesh.origin[0] : 0) - batchOrigin[0];
    const doy = (mesh.origin ? mesh.origin[1] : 0) - batchOrigin[1];
    const doz = (mesh.origin ? mesh.origin[2] : 0) - batchOrigin[2];

    // Interleave vertex data (position + normal + entityId)
    let outIdx = vertexBase * 7;
    const perVertexEntityIds = mesh.entityIds; // color-merged batches
    let entityId = mesh.expressId >>> 0;
    if (!perVertexEntityIds && entityId > MAX_ENCODED_ENTITY_ID) {
      if (!warnedEntityIdRange) {
        warnedEntityIdRange = true;
        console.warn('[Renderer] expressId exceeds 24-bit seam-ID encoding range; seam lines may collide.');
      }
      entityId = entityId & MAX_ENCODED_ENTITY_ID;
    }
    // High-8-bit material-colour salt → identical nudge in base & overlay passes
    // (so the lens/IDS/compare/4D overlay's depthCompare:'equal' matches). See
    // colorSaltByte() above.
    const saltByte = colorSaltByte(mesh.color);
    const hasNormals = normals.length > 0;
    for (let i = 0; i < vertexCount; i++) {
      const srcIdx = i * 3;
      vertexData[outIdx++] = positions[srcIdx] + dox;
      vertexData[outIdx++] = positions[srcIdx + 1] + doy;
      vertexData[outIdx++] = positions[srcIdx + 2] + doz;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx] : 0;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx + 1] : 0;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx + 2] : 0;
      vertexDataU32[outIdx++] = packEntityLane(perVertexEntityIds ? perVertexEntityIds[i] : entityId, saltByte);
    }

    // Copy indices with vertex base offset
    const meshIndices = mesh.indices;
    const indexCount = meshIndices.length;
    for (let i = 0; i < indexCount; i++) {
      indices[indexOffset + i] = meshIndices[i] + vertexBase;
    }

    vertexBase += vertexCount;
    indexOffset += indexCount;
  }

  return {
    vertexData,
    indices,
    // WORLD-space bounds (from the pre-pass) so raycast/fit/section stay world.
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
    origin: batchOrigin,
  };
}

/**
 * Split a meshDataArray into chunks where each chunk's largest buffer
 * (vertex or index) stays within maxBufferSize.
 *
 * Each mesh is kept intact — we never split a single element's geometry.
 * If a single mesh exceeds the limit on its own it is placed in a solo chunk
 * (WebGPU will clamp or error, but we don't silently drop geometry).
 */
export function splitMeshDataForBufferLimit(meshDataArray: MeshData[], maxBufferSize: number): MeshData[][] {
  // Fast path: estimate total size — if it fits, no splitting needed
  let totalVertexBytes = 0;
  let totalIndexBytes = 0;
  for (const mesh of meshDataArray) {
    totalVertexBytes += (mesh.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
    totalIndexBytes += mesh.indices.length * BATCH_CONSTANTS.BYTES_PER_INDEX;
  }
  if (totalVertexBytes <= maxBufferSize && totalIndexBytes <= maxBufferSize) {
    return [meshDataArray];
  }

  // Slow path: partition into chunks
  const chunks: MeshData[][] = [];
  let currentChunk: MeshData[] = [];
  let currentVertexBytes = 0;
  let currentIndexBytes = 0;

  for (const mesh of meshDataArray) {
    const meshVertexBytes = (mesh.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
    const meshIndexBytes = mesh.indices.length * BATCH_CONSTANTS.BYTES_PER_INDEX;

    // Would adding this mesh exceed the limit? Start a new chunk.
    // (Skip check when chunk is empty — a single mesh must always be included.)
    if (
      currentChunk.length > 0 &&
      (currentVertexBytes + meshVertexBytes > maxBufferSize ||
       currentIndexBytes + meshIndexBytes > maxBufferSize)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentVertexBytes = 0;
      currentIndexBytes = 0;
    }

    currentChunk.push(mesh);
    currentVertexBytes += meshVertexBytes;
    currentIndexBytes += meshIndexBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
