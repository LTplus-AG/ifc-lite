/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry serialization
 */

import type { MeshData, CoordinateInfo, Vec3, AABB } from '@ifc-lite/geometry';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write geometry data to buffer
 * Format:
 *   - meshCount: uint32
 *   - totalVertices: uint32
 *   - totalTriangles: uint32
 *   - coordinateInfo (see below)
 *   - per mesh:
 *     - expressId: uint32
 *     - vertexCount: uint32
 *     - indexCount: uint32
 *     - color: float32[4]
 *     - ifcType: string            (version >= 2)
 *     - geometryClass: uint8       (version >= 5) — 0 occurrence, 1 orphan
 *                                   type, 2 instanced type (Model/Types switch)
 *     - positions: Float32Array[vertexCount * 3]
 *     - normals: Float32Array[vertexCount * 3]
 *     - indices: Uint32Array[indexCount]
 */
export function writeGeometry(
  writer: BufferWriter,
  meshes: MeshData[],
  totalVertices: number,
  totalTriangles: number,
  coordinateInfo: CoordinateInfo
): void {
  const { validMeshes, actualTotalVertices, actualTotalTriangles } = validateMeshes(meshes);

  // Write header with actual counts
  writer.writeUint32(validMeshes.length);
  writer.writeUint32(actualTotalVertices);
  writer.writeUint32(actualTotalTriangles);

  // Write coordinate info
  writeCoordinateInfo(writer, coordinateInfo);

  // Write each valid mesh
  for (const mesh of validMeshes) {
    writeMeshRecord(writer, mesh);
  }

  if (validMeshes.length < meshes.length) {
    console.warn(`[writeGeometry] Wrote ${validMeshes.length}/${meshes.length} meshes (${meshes.length - validMeshes.length} skipped due to data issues)`);
  }
}

/**
 * Validate + filter meshes (detached buffers / size mismatches / absurd
 * counts) and recompute the real totals. Shared by the legacy sequential
 * writer above and the v13 chunked writer.
 */
export function validateMeshes(meshes: MeshData[]): {
  validMeshes: MeshData[];
  actualTotalVertices: number;
  actualTotalTriangles: number;
} {
  const validMeshes: MeshData[] = [];
  let actualTotalVertices = 0;
  let actualTotalTriangles = 0;

  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const vertexCount = mesh.positions.length / 3;
    const indexCount = mesh.indices.length;

    // Sanity check: vertex/index counts should be reasonable
    if (vertexCount > MAX_VERTEX_COUNT || indexCount > MAX_INDEX_COUNT) {
      console.warn(`[writeGeometry] Skipping mesh ${i} (expressId=${mesh.expressId}): unreasonable counts`);
      continue;
    }

    // Verify array integrity (check for detached buffers or size mismatches)
    // Note: Some WASM-generated meshes may have mismatched array sizes - skip them
    if (mesh.normals.length !== mesh.positions.length) {
      console.warn(`[writeGeometry] Skipping mesh ${i} (expressId=${mesh.expressId}): normals/positions size mismatch (${mesh.normals.length} vs ${mesh.positions.length})`);
      continue;
    }

    validMeshes.push(mesh);
    actualTotalVertices += vertexCount;
    actualTotalTriangles += indexCount / 3;
  }

  return { validMeshes, actualTotalVertices, actualTotalTriangles };
}

/**
 * One per-mesh record — the layout is IDENTICAL in the legacy sequential
 * section and inside v13 chunk records (v13 only changes how records are
 * GROUPED, not what a record is).
 */
export function writeMeshRecord(writer: BufferWriter, mesh: MeshData): void {
  writer.writeUint32(mesh.expressId);

  const vertexCount = mesh.positions.length / 3;
  const indexCount = mesh.indices.length;

  writer.writeUint32(vertexCount);
  writer.writeUint32(indexCount);

  // Write color (RGBA)
  writer.writeFloat32(mesh.color[0]);
  writer.writeFloat32(mesh.color[1]);
  writer.writeFloat32(mesh.color[2]);
  writer.writeFloat32(mesh.color[3]);

  // Write ifcType (as string length + UTF-8 bytes)
  const ifcType = mesh.ifcType || '';
  writer.writeString(ifcType);

  // Write geometryClass (#957 Model/Types switch). Without this the viewer's
  // view-mode filter sees every cache-restored mesh as class 0: instanced
  // type-library geometry reappears in Model mode and the switch disappears.
  writer.writeUint8(mesh.geometryClass ?? 0);

  // Write per-element local-frame origin (v6+, 3×f64): world = origin +
  // position. [0,0,0] for absolute meshes. Without it a cache from a
  // local-frame load restores small local positions with no origin → every
  // element renders scattered near scene origin.
  writer.writeFloat64(mesh.origin ? mesh.origin[0] : 0);
  writer.writeFloat64(mesh.origin ? mesh.origin[1] : 0);
  writer.writeFloat64(mesh.origin ? mesh.origin[2] : 0);

  // Write geometry arrays
  writer.writeTypedArray(mesh.positions);
  writer.writeTypedArray(mesh.normals);
  writer.writeTypedArray(mesh.indices);
}

/** Exact serialized size of one per-mesh record, for chunk byte budgeting. */
export function meshRecordByteLength(mesh: MeshData): number {
  const ifcTypeBytes = mesh.ifcType ? new TextEncoder().encode(mesh.ifcType).length : 0;
  return (
    4 + 4 + 4 +            // expressId, vertexCount, indexCount
    16 +                   // color f32x4
    4 + ifcTypeBytes +     // ifcType string
    1 +                    // geometryClass
    24 +                   // origin f64x3
    mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength
  );
}

export function writeCoordinateInfo(writer: BufferWriter, info: CoordinateInfo): void {
  // Origin shift
  writeVec3(writer, info.originShift);

  // Original bounds
  writeAABB(writer, info.originalBounds);

  // Shifted bounds
  writeAABB(writer, info.shiftedBounds);

  // Has large coordinates flag (was misnamed isGeoReferenced)
  writer.writeUint8(info.hasLargeCoordinates ? 1 : 0);

  // Write wasmRtcOffset (optional)
  const hasWasmRtc = info.wasmRtcOffset !== undefined;
  writer.writeUint8(hasWasmRtc ? 1 : 0);
  if (hasWasmRtc) {
    writeVec3(writer, info.wasmRtcOffset!);
  }

  // Write buildingRotation (optional)
  const hasBuildingRotation = info.buildingRotation !== undefined;
  writer.writeUint8(hasBuildingRotation ? 1 : 0);
  if (hasBuildingRotation) {
    writer.writeFloat64(info.buildingRotation!);
  }
}

function writeVec3(writer: BufferWriter, v: Vec3): void {
  writer.writeFloat64(v.x);
  writer.writeFloat64(v.y);
  writer.writeFloat64(v.z);
}

function writeAABB(writer: BufferWriter, aabb: AABB): void {
  writeVec3(writer, aabb.min);
  writeVec3(writer, aabb.max);
}

/**
 * Read geometry data from buffer
 */
// Maximum reasonable values for sanity checking
const MAX_MESH_COUNT = 10_000_000; // 10M meshes max
const MAX_VERTEX_COUNT = 100_000_000; // 100M vertices max per mesh
const MAX_INDEX_COUNT = 300_000_000; // 300M indices max per mesh

export function readGeometry(reader: BufferReader, version: number = 2): {
  meshes: MeshData[];
  totalVertices: number;
  totalTriangles: number;
  coordinateInfo: CoordinateInfo;
} {
  const meshCount = reader.readUint32();
  const totalVertices = reader.readUint32();
  const totalTriangles = reader.readUint32();

  // Sanity check mesh count
  if (meshCount > MAX_MESH_COUNT) {
    throw new Error(`Invalid cache: meshCount ${meshCount} exceeds maximum ${MAX_MESH_COUNT}. Cache may be corrupted or from incompatible version.`);
  }

  const coordinateInfo = readCoordinateInfo(reader, version);

  const meshes: MeshData[] = [];

  for (let i = 0; i < meshCount; i++) {
    meshes.push(readMeshRecord(reader, version, i));
  }

  return {
    meshes,
    totalVertices,
    totalTriangles,
    coordinateInfo,
  };
}

/** Read one per-mesh record (see writeMeshRecord for the layout). */
export function readMeshRecord(reader: BufferReader, version: number, meshIndex: number = 0): MeshData {
  const expressId = reader.readUint32();
  const vertexCount = reader.readUint32();
  const indexCount = reader.readUint32();

  // Sanity check vertex/index counts
  if (vertexCount > MAX_VERTEX_COUNT) {
    throw new Error(`Invalid cache: vertexCount ${vertexCount} exceeds maximum ${MAX_VERTEX_COUNT} at mesh ${meshIndex}. Cache may be corrupted or from incompatible version.`);
  }
  if (indexCount > MAX_INDEX_COUNT) {
    throw new Error(`Invalid cache: indexCount ${indexCount} exceeds maximum ${MAX_INDEX_COUNT} at mesh ${meshIndex}. Cache may be corrupted or from incompatible version.`);
  }

  const color: [number, number, number, number] = [
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
  ];

  // Read ifcType (only in version 2+)
  let ifcType: string | undefined = undefined;
  if (version >= 2) {
    ifcType = reader.readString() || undefined;
  }

  // Read geometryClass (version 5+) — the Model/Types view-switch tag.
  // Older caches default to 0 (occurrence); v4 entries are bypassed by the
  // viewer's bumped cache key, so they re-mesh fresh rather than load here.
  const geometryClass = version >= 5 ? reader.readUint8() : 0;

  // Read per-element local-frame origin (version 6+); world = origin + position.
  let origin: [number, number, number] | undefined;
  if (version >= 6) {
    const ox = reader.readFloat64();
    const oy = reader.readFloat64();
    const oz = reader.readFloat64();
    if (ox || oy || oz) origin = [ox, oy, oz];
  }

  const positions = reader.readFloat32Array(vertexCount * 3);
  const normals = reader.readFloat32Array(vertexCount * 3);
  const indices = reader.readUint32Array(indexCount);

  return {
    expressId,
    positions,
    normals,
    indices,
    color,
    ifcType,
    geometryClass,
    ...(origin ? { origin } : {}),
  };
}

export function readCoordinateInfo(reader: BufferReader, version: number = 2): CoordinateInfo {
  const originShift = readVec3(reader);
  const originalBounds = readAABB(reader);
  const shiftedBounds = readAABB(reader);
  const hasLargeCoordinates = reader.readUint8() === 1;

  // Version 3+: read optional fields
  let wasmRtcOffset: Vec3 | undefined;
  let buildingRotation: number | undefined;

  if (version >= 3) {
    if (reader.readUint8() === 1) {
      wasmRtcOffset = readVec3(reader);
    }
    if (reader.readUint8() === 1) {
      buildingRotation = reader.readFloat64();
    }
  }

  return {
    originShift,
    originalBounds,
    shiftedBounds,
    hasLargeCoordinates,
    wasmRtcOffset,
    buildingRotation,
  };
}

function readVec3(reader: BufferReader): Vec3 {
  return {
    x: reader.readFloat64(),
    y: reader.readFloat64(),
    z: reader.readFloat64(),
  };
}

function readAABB(reader: BufferReader): AABB {
  return {
    min: readVec3(reader),
    max: readVec3(reader),
  };
}
