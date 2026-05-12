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
 * Merge multiple mesh geometries into single interleaved vertex/index buffers.
 *
 * Layout per vertex: position (3f) + normal (3f) + entityId (1u32) = 7 × 4 bytes.
 * Bounds are tracked during the merge pass to avoid a second iteration.
 */
export function mergeGeometry(meshDataArray: MeshData[]): {
  vertexData: Float32Array;
  indices: Uint32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
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

  // Track bounds during merge (avoids a second pass)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let indexOffset = 0;
  let vertexBase = 0;

  for (const mesh of meshDataArray) {
    const positions = mesh.positions;
    const normals = mesh.normals;
    const vertexCount = positions.length / 3;

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
    const hasNormals = normals.length > 0;
    for (let i = 0; i < vertexCount; i++) {
      const srcIdx = i * 3;
      const px = positions[srcIdx];
      const py = positions[srcIdx + 1];
      const pz = positions[srcIdx + 2];
      vertexData[outIdx++] = px;
      vertexData[outIdx++] = py;
      vertexData[outIdx++] = pz;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx] : 0;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx + 1] : 0;
      vertexData[outIdx++] = hasNormals ? normals[srcIdx + 2] : 0;
      vertexDataU32[outIdx++] = perVertexEntityIds ? (perVertexEntityIds[i] >>> 0) : entityId;

      // Update bounds
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
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
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
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
