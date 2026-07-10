/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * v13 chunked geometry section (issue #1682, phase 4).
 *
 * Layout (all offsets little-endian, relative to the geometry SECTION start):
 *   headLength: u32                      // byte length of everything below
 *                                        // up to (not incl.) the first chunk
 *   meshCount: u32
 *   totalVertices: u32
 *   totalTriangles: u32
 *   coordinateInfo                       // unchanged, variable length
 *   chunkCount: u32
 *   directory: chunkCount × 44 bytes {
 *     aabbMin f32×3, aabbMax f32×3,      // world AABB of the chunk
 *     byteOffset u32,                    // chunk record, rel. section start
 *     byteLength u32,                    // STORED length (compressed if so)
 *     uncompressedLength u32,
 *     meshCount u32,
 *     flags u32                          // GeometryChunkFlags
 *   }
 *   ...chunk records at their byteOffsets
 *
 * A chunk record is a plain concatenation of per-mesh records (identical
 * layout to v12 — see geometry.ts writeMeshRecord), optionally deflate-raw
 * compressed. Chunks are spatially coherent (grid cell of origin + first
 * vertex, soft byte cap; a mesh never splits), so a streamed reader paints
 * coherent regions and a future evict-to-disk residency layer can re-read
 * one chunk without touching the rest.
 */

import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import {
  GEOMETRY_CHUNK_CELL_SIZE,
  GEOMETRY_CHUNK_SOFT_BYTES,
  GEOMETRY_CHUNK_COMPRESS_MIN_BYTES,
  GeometryChunkFlags,
  type GeometryChunkInfo,
} from '../types.js';
import {
  validateMeshes,
  writeMeshRecord,
  readMeshRecord,
  meshRecordByteLength,
  writeCoordinateInfo,
  readCoordinateInfo,
} from './geometry.js';

// 6×f32 AABB (24) + 5×u32 (offset, length, uncompressed, meshCount, flags).
const DIRECTORY_ENTRY_BYTES = 44;

/** Parsed head of a v13 geometry section. */
export interface GeometryHead {
  meshCount: number;
  totalVertices: number;
  totalTriangles: number;
  coordinateInfo: CoordinateInfo;
  chunks: GeometryChunkInfo[];
}

// ─── codec ────────────────────────────────────────────────────────────────

async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  // Copy into a fresh standalone buffer: `data` may be a subarray view, and
  // Response/Blob would otherwise serialize the WHOLE backing buffer.
  const standalone = new Uint8Array(data);
  const out = await new Response(new Blob([standalone]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export const deflateRaw = (data: Uint8Array): Promise<Uint8Array> =>
  pipeThrough(data, new CompressionStream('deflate-raw'));

export const inflateRaw = (data: Uint8Array): Promise<Uint8Array> =>
  pipeThrough(data, new DecompressionStream('deflate-raw'));

// ─── write ────────────────────────────────────────────────────────────────

/** Grid cell of a mesh's world anchor (origin + first vertex) — a spatial
 *  grouping heuristic only; readers trust the directory, never this. */
function cellKeyOf(mesh: MeshData): string {
  const o = mesh.origin;
  const hasVertex = mesh.positions.length >= 3;
  const x = (o ? o[0] : 0) + (hasVertex ? mesh.positions[0] : 0);
  const y = (o ? o[1] : 0) + (hasVertex ? mesh.positions[1] : 0);
  const z = (o ? o[2] : 0) + (hasVertex ? mesh.positions[2] : 0);
  const cx = Math.floor(x / GEOMETRY_CHUNK_CELL_SIZE);
  const cy = Math.floor(y / GEOMETRY_CHUNK_CELL_SIZE);
  const cz = Math.floor(z / GEOMETRY_CHUNK_CELL_SIZE);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return 'nan';
  return `${cx},${cy},${cz}`;
}

interface PendingChunk {
  meshes: MeshData[];
  bytes: number;
}

/** Group meshes into spatially coherent, byte-capped chunks (order-stable). */
export function groupMeshesIntoChunks(
  meshes: MeshData[],
  softBytes: number = GEOMETRY_CHUNK_SOFT_BYTES
): MeshData[][] {
  const open = new Map<string, PendingChunk>();
  const closed: MeshData[][] = [];
  for (const mesh of meshes) {
    const key = cellKeyOf(mesh);
    let chunk = open.get(key);
    const bytes = meshRecordByteLength(mesh);
    if (chunk && chunk.bytes > 0 && chunk.bytes + bytes > softBytes) {
      closed.push(chunk.meshes);
      chunk = undefined;
    }
    if (!chunk) {
      chunk = { meshes: [], bytes: 0 };
      open.set(key, chunk);
    }
    chunk.meshes.push(mesh);
    chunk.bytes += bytes;
  }
  for (const chunk of open.values()) {
    if (chunk.meshes.length > 0) closed.push(chunk.meshes);
  }
  return closed;
}

function chunkAabb(meshes: MeshData[]): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    const pos = mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const x = ox + pos[i], y = oy + pos[i + 1], z = oz + pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (minX === Infinity) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Build the complete v13 geometry section buffer. Async because per-chunk
 * compression uses the (browser/Node-native) CompressionStream.
 */
export async function buildGeometrySectionV13(
  meshes: MeshData[],
  coordinateInfo: CoordinateInfo,
  options: { compress?: boolean } = {}
): Promise<ArrayBuffer> {
  const compress = options.compress ?? true;
  const { validMeshes, actualTotalVertices, actualTotalTriangles } = validateMeshes(meshes);
  const groups = groupMeshesIntoChunks(validMeshes);

  // Serialize (and optionally compress) every chunk record.
  const records: Array<{
    bytes: Uint8Array;
    uncompressedLength: number;
    meshCount: number;
    flags: GeometryChunkFlags;
    aabb: { min: [number, number, number]; max: [number, number, number] };
  }> = await Promise.all(groups.map(async (group) => {
    const w = new BufferWriter(64 * 1024);
    for (const mesh of group) writeMeshRecord(w, mesh);
    const raw = new Uint8Array(w.build());
    let bytes: Uint8Array<ArrayBufferLike> = raw;
    let flags = GeometryChunkFlags.None;
    if (compress && raw.byteLength >= GEOMETRY_CHUNK_COMPRESS_MIN_BYTES) {
      const deflated = await deflateRaw(raw);
      // Keep the raw record when compression doesn't pay (already-dense data).
      if (deflated.byteLength < raw.byteLength) {
        bytes = deflated;
        flags = GeometryChunkFlags.DeflateRaw;
      }
    }
    return {
      bytes,
      uncompressedLength: raw.byteLength,
      meshCount: group.length,
      flags,
      aabb: chunkAabb(group),
    };
  }));

  // Head: counts + coordinateInfo + directory. Directory offsets need the
  // head length, which needs the coordinateInfo length — write the variable
  // part once to measure it.
  const headBody = new BufferWriter(16 * 1024);
  headBody.writeUint32(validMeshes.length);
  headBody.writeUint32(actualTotalVertices);
  headBody.writeUint32(actualTotalTriangles);
  writeCoordinateInfo(headBody, coordinateInfo);
  headBody.writeUint32(records.length);
  const headLength = headBody.position + records.length * DIRECTORY_ENTRY_BYTES;

  let offset = 4 + headLength; // headLength field itself + head
  const finalWriter = new BufferWriter(offset + records.reduce((s, r) => s + r.bytes.byteLength, 0));
  finalWriter.writeUint32(headLength);
  finalWriter.writeBytes(new Uint8Array(headBody.build()));
  for (const r of records) {
    finalWriter.writeFloat32(r.aabb.min[0]);
    finalWriter.writeFloat32(r.aabb.min[1]);
    finalWriter.writeFloat32(r.aabb.min[2]);
    finalWriter.writeFloat32(r.aabb.max[0]);
    finalWriter.writeFloat32(r.aabb.max[1]);
    finalWriter.writeFloat32(r.aabb.max[2]);
    finalWriter.writeUint32(offset);
    finalWriter.writeUint32(r.bytes.byteLength);
    finalWriter.writeUint32(r.uncompressedLength);
    finalWriter.writeUint32(r.meshCount);
    finalWriter.writeUint32(r.flags);
    offset += r.bytes.byteLength;
  }
  for (const r of records) {
    finalWriter.writeBytes(r.bytes);
  }
  return finalWriter.build();
}

// ─── read ─────────────────────────────────────────────────────────────────

/** Parse the v13 geometry head; `reader` must be positioned at the geometry
 *  section start. Cheap: never touches chunk records. */
export function readGeometryHeadV13(reader: BufferReader): GeometryHead {
  const headLength = reader.readUint32();
  void headLength; // total head size — used by range readers to bound the head fetch
  const meshCount = reader.readUint32();
  const totalVertices = reader.readUint32();
  const totalTriangles = reader.readUint32();
  const coordinateInfo = readCoordinateInfo(reader, 13);
  const chunkCount = reader.readUint32();
  const chunks: GeometryChunkInfo[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      aabbMin: [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()],
      aabbMax: [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()],
      byteOffset: reader.readUint32(),
      byteLength: reader.readUint32(),
      uncompressedLength: reader.readUint32(),
      meshCount: reader.readUint32(),
      flags: reader.readUint32(),
    });
  }
  return { meshCount, totalVertices, totalTriangles, coordinateInfo, chunks };
}

/** Decode one chunk record's stored bytes into meshes. */
export async function decodeGeometryChunk(
  stored: Uint8Array,
  info: GeometryChunkInfo,
  version: number
): Promise<MeshData[]> {
  const raw = (info.flags & GeometryChunkFlags.DeflateRaw) ? await inflateRaw(stored) : stored;
  if (raw.byteLength !== info.uncompressedLength) {
    throw new Error(`Invalid cache: chunk decoded to ${raw.byteLength} bytes, directory says ${info.uncompressedLength}`);
  }
  // BufferReader wants an exact ArrayBuffer; raw may be a view.
  const buffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
    ? raw.buffer
    : raw.slice().buffer;
  const reader = new BufferReader(buffer as ArrayBuffer);
  const meshes: MeshData[] = [];
  for (let i = 0; i < info.meshCount; i++) {
    meshes.push(readMeshRecord(reader, version, i));
  }
  return meshes;
}

/**
 * Incremental access to a v13 geometry section inside a fully loaded cache
 * buffer. `sectionOffset` is the Geometry section's absolute offset (from
 * the section table). A future evict-to-disk layer swaps the buffer for a
 * Blob and turns the subarray into a slice() read — the head/chunk contract
 * is already shaped for that.
 */
export function openGeometryChunksV13(
  buffer: ArrayBuffer,
  sectionOffset: number,
  version: number
): GeometryHead & { readChunk(index: number): Promise<MeshData[]> } {
  const reader = new BufferReader(buffer);
  reader.position = sectionOffset;
  const head = readGeometryHeadV13(reader);
  const bytes = new Uint8Array(buffer);
  return {
    ...head,
    readChunk(index: number): Promise<MeshData[]> {
      const info = head.chunks[index];
      if (!info) return Promise.reject(new Error(`chunk index ${index} out of range (${head.chunks.length})`));
      const start = sectionOffset + info.byteOffset;
      return decodeGeometryChunk(bytes.subarray(start, start + info.byteLength), info, version);
    },
  };
}

/** Full sequential decode of a v13 geometry section (the legacy-shaped result). */
export async function readGeometryV13(
  buffer: ArrayBuffer,
  sectionOffset: number,
  version: number
): Promise<{ meshes: MeshData[]; totalVertices: number; totalTriangles: number; coordinateInfo: CoordinateInfo }> {
  const open = openGeometryChunksV13(buffer, sectionOffset, version);
  const meshes: MeshData[] = [];
  for (let i = 0; i < open.chunks.length; i++) {
    meshes.push(...await open.readChunk(i));
  }
  return {
    meshes,
    totalVertices: open.totalVertices,
    totalTriangles: open.totalTriangles,
    coordinateInfo: open.coordinateInfo,
  };
}
