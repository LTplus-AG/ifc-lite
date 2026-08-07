/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type conversion functions for the native Tauri bridge.
 *
 * Converts native Rust data structures (received via Tauri invoke) into
 * the TypeScript types used by the geometry package.
 */

import type { NativeBatchTelemetry } from './platform-bridge.js';
import type { MeshData, CoordinateInfo } from './types.js';

// Native types from Rust (camelCase due to serde rename)
export interface NativeMeshData {
  expressId: number;
  ifcType?: string;
  positions: number[];
  normals: number[];
  indices: number[];
  color: [number, number, number, number];
}

export interface NativePackedMeshRange {
  expressId: number;
  ifcType?: string;
  positionsOffset: number;
  positionsLen: number;
  normalsOffset: number;
  normalsLen: number;
  indicesOffset: number;
  indicesLen: number;
  color: [number, number, number, number];
}

export interface NativePackedGeometryBatch {
  meshes: NativePackedMeshRange[];
  positions: number[];
  normals: number[];
  indices: number[];
  progress: { processed: number; total: number; currentType: string };
  telemetry?: NativeBatchTelemetryPayload;
}

export interface NativePoint3 {
  x: number;
  y: number;
  z: number;
}

export interface NativeBounds {
  min: NativePoint3;
  max: NativePoint3;
}

export interface NativeCoordinateInfo {
  originShift: NativePoint3;
  originalBounds: NativeBounds;
  shiftedBounds: NativeBounds;
  hasLargeCoordinates: boolean;
}

export interface NativeBatchTelemetryPayload {
  batchSequence: number;
  payloadKind: string;
  meshCount: number;
  positionsLen: number;
  normalsLen: number;
  indicesLen: number;
  chunkReadyTimeMs: number;
  packTimeMs: number;
  emitTimeMs: number;
  emittedTimeMs: number;
}

export function convertNativeMesh(native: NativeMeshData): MeshData {
  return {
    expressId: native.expressId,
    ifcType: native.ifcType,
    positions: new Float32Array(native.positions),
    normals: new Float32Array(native.normals),
    indices: new Uint32Array(native.indices),
    color: native.color,
  };
}

/**
 * Whether `[offset, offset + length)` is a real range inside a pool of
 * `poolLength` elements. Both bounds must be non-negative integers: a NaN or
 * negative value would pass a bare `offset + length > poolLength` comparison
 * and then be silently reinterpreted by `subarray`.
 */
function isPoolRange(offset: number, length: number, poolLength: number): boolean {
  return (
    Number.isInteger(offset) &&
    Number.isInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= poolLength
  );
}

export function convertPackedNativeBatch(native: NativePackedGeometryBatch): MeshData[] {
  // Copy each packed numeric array once, then hand meshes cheap subarray views
  // instead of slicing and copying per mesh.
  const positions = Float32Array.from(native.positions);
  const normals = Float32Array.from(native.normals);
  const indices = Uint32Array.from(native.indices);

  return native.meshes.map((mesh, meshIndex) => {
    // Validate each mesh's pool ranges before subarray — a malformed offset
    // would otherwise silently clip (subarray saturates), yielding
    // truncated-or-borrowed geometry indistinguishable from a real mesh.
    // Mirrors the guard on the binary packed-cache-shard decoder
    // (packed-geometry-decoder.ts) for the same offset/length table shape.
    //
    // An upper-bound check alone is NOT enough here. The binary decoder's
    // offsets come from `getUint32`, so they are non-negative integers by
    // construction; these arrive as plain JS numbers on an IPC payload.
    // `NaN + len > length` is false, so NaN would pass and
    // `subarray(NaN, NaN)` returns an EMPTY view — a mesh reported as
    // converted while carrying no geometry. A negative offset also passes,
    // and makes `subarray` count from the END of the pool. Require a
    // non-negative integer for each before comparing.
    if (
      !isPoolRange(mesh.positionsOffset, mesh.positionsLen, positions.length) ||
      !isPoolRange(mesh.normalsOffset, mesh.normalsLen, normals.length) ||
      !isPoolRange(mesh.indicesOffset, mesh.indicesLen, indices.length)
    ) {
      throw new Error(`Native packed geometry batch mesh ${meshIndex} pool offset out of bounds`);
    }
    return {
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      positions: positions.subarray(mesh.positionsOffset, mesh.positionsOffset + mesh.positionsLen),
      normals: normals.subarray(mesh.normalsOffset, mesh.normalsOffset + mesh.normalsLen),
      indices: indices.subarray(mesh.indicesOffset, mesh.indicesOffset + mesh.indicesLen),
      color: mesh.color,
    };
  });
}

export function convertNativeBatchTelemetry(
  telemetry: NativeBatchTelemetryPayload | undefined,
  jsReceivedTimeMs: number
): NativeBatchTelemetry | undefined {
  if (!telemetry) {
    return undefined;
  }

  return {
    batchSequence: telemetry.batchSequence,
    payloadKind: telemetry.payloadKind,
    meshCount: telemetry.meshCount,
    positionsLen: telemetry.positionsLen,
    normalsLen: telemetry.normalsLen,
    indicesLen: telemetry.indicesLen,
    chunkReadyTimeMs: telemetry.chunkReadyTimeMs,
    packTimeMs: telemetry.packTimeMs,
    emitTimeMs: telemetry.emitTimeMs,
    emittedTimeMs: telemetry.emittedTimeMs,
    jsReceivedTimeMs,
  };
}

export function convertNativeCoordinateInfo(native: NativeCoordinateInfo): CoordinateInfo {
  return {
    originShift: native.originShift,
    originalBounds: native.originalBounds,
    shiftedBounds: native.shiftedBounds,
    hasLargeCoordinates: native.hasLargeCoordinates,
  };
}
