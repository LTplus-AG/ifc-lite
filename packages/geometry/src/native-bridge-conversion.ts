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

export function convertPackedNativeBatch(native: NativePackedGeometryBatch): MeshData[] {
  // Copy each packed numeric array once, then hand meshes cheap subarray views
  // instead of slicing and copying per mesh.
  const positions = Float32Array.from(native.positions);
  const normals = Float32Array.from(native.normals);
  const indices = Uint32Array.from(native.indices);

  return native.meshes.map((mesh) => ({
    expressId: mesh.expressId,
    ifcType: mesh.ifcType,
    positions: positions.subarray(mesh.positionsOffset, mesh.positionsOffset + mesh.positionsLen),
    normals: normals.subarray(mesh.normalsOffset, mesh.normalsOffset + mesh.normalsLen),
    indices: indices.subarray(mesh.indicesOffset, mesh.indicesOffset + mesh.indicesLen),
    color: mesh.color,
  }));
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
