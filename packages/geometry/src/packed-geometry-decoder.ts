/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Binary format parsing for packed geometry cache shards.
 *
 * Decodes the binary shard format emitted by the native Rust geometry
 * pipeline into GeometryBatch objects consumable by the renderer.
 */

import type { GeometryBatch } from './platform-bridge.js';
import type { MeshData } from './types.js';

/**
 * Convert an unknown payload (ArrayBuffer, Uint8Array, or number[]) into an
 * ArrayBuffer suitable for DataView / TypedArray construction.
 */
export function toArrayBuffer(payload: unknown): ArrayBuffer {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    if (
      payload.byteOffset === 0
      && payload.byteLength === payload.buffer.byteLength
      && payload.buffer instanceof ArrayBuffer
    ) {
      return payload.buffer;
    }
    return payload.slice().buffer;
  }
  if (Array.isArray(payload)) {
    return Uint8Array.from(payload as number[]).buffer;
  }
  throw new Error(`Unsupported packed geometry shard payload: ${typeof payload}`);
}

/**
 * Decode a packed geometry cache shard from its binary representation into a
 * GeometryBatch.
 *
 * Binary layout (all little-endian uint32 unless noted):
 *   Header (8 words): magic, version, meshCount, positionsLen, normalsLen,
 *                      indicesLen, processed, total
 *   Mesh table (meshCount * 11 words each): expressId, posOff, posLen, nrmOff,
 *                      nrmLen, idxOff, idxLen, color(r,g,b,a as float32)
 *   Data: positions (Float32), normals (Float32), indices (Uint32)
 */
export function decodePackedGeometryCacheShard(
  payload: unknown,
  jsReceivedTimeMs: number,
  batchSequence: number
): GeometryBatch {
  const buffer = toArrayBuffer(payload);
  const header = new Uint32Array(buffer, 0, 8);
  const [magic, version, meshCount, positionsLen, normalsLen, indicesLen, processed, total] = header;
  if (magic !== 0x49464342) {
    throw new Error('Invalid packed geometry cache shard magic');
  }
  if (version !== 1) {
    throw new Error(`Unsupported packed geometry cache shard version: ${version}`);
  }

  const meshRecordWordLength = 11;
  const meshWordOffset = 8;
  const meshTableWords = meshCount * meshRecordWordLength;
  const dataByteOffset = (meshWordOffset + meshTableWords) * Uint32Array.BYTES_PER_ELEMENT;
  const positionsByteLength = positionsLen * Float32Array.BYTES_PER_ELEMENT;
  const normalsByteLength = normalsLen * Float32Array.BYTES_PER_ELEMENT;
  const indicesByteLength = indicesLen * Uint32Array.BYTES_PER_ELEMENT;
  const positionsOffset = dataByteOffset;
  const normalsOffset = positionsOffset + positionsByteLength;
  const indicesOffset = normalsOffset + normalsByteLength;

  const positions = new Float32Array(buffer, positionsOffset, positionsLen);
  const normals = new Float32Array(buffer, normalsOffset, normalsLen);
  const indices = new Uint32Array(buffer, indicesOffset, indicesLen);
  const meshView = new DataView(
    buffer,
    meshWordOffset * Uint32Array.BYTES_PER_ELEMENT,
    meshTableWords * Uint32Array.BYTES_PER_ELEMENT
  );

  const meshes: MeshData[] = [];
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex += 1) {
    const base = meshIndex * meshRecordWordLength * Uint32Array.BYTES_PER_ELEMENT;
    const expressId = meshView.getUint32(base, true);
    const positionsOffsetWords = meshView.getUint32(base + 4, true);
    const positionsLengthWords = meshView.getUint32(base + 8, true);
    const normalsOffsetWords = meshView.getUint32(base + 12, true);
    const normalsLengthWords = meshView.getUint32(base + 16, true);
    const indicesOffsetWords = meshView.getUint32(base + 20, true);
    const indicesLengthWords = meshView.getUint32(base + 24, true);
    const color: [number, number, number, number] = [
      meshView.getFloat32(base + 28, true),
      meshView.getFloat32(base + 32, true),
      meshView.getFloat32(base + 36, true),
      meshView.getFloat32(base + 40, true),
    ];
    meshes.push({
      expressId,
      positions: positions.subarray(positionsOffsetWords, positionsOffsetWords + positionsLengthWords),
      normals: normals.subarray(normalsOffsetWords, normalsOffsetWords + normalsLengthWords),
      indices: indices.subarray(indicesOffsetWords, indicesOffsetWords + indicesLengthWords),
      color,
    });
  }

  return {
    meshes,
    progress: {
      processed,
      total,
      currentType: 'cached',
    },
    nativeTelemetry: {
      batchSequence,
      payloadKind: 'packed-cache-shard',
      meshCount,
      positionsLen,
      normalsLen,
      indicesLen,
      chunkReadyTimeMs: 0,
      packTimeMs: 0,
      emitTimeMs: 0,
      emittedTimeMs: 0,
      jsReceivedTimeMs,
    },
  };
}
