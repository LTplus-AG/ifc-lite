/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate transform utilities and batch-conversion helpers.
 *
 * Pure functions that convert WASM mesh/instanced-geometry collections
 * into plain MeshData arrays, compute streaming batch sizes, and merge
 * building rotation into coordinate info.
 */

import type { MeshData, CoordinateInfo } from './types.js';
import type { DynamicBatchConfig } from './index.js';

// ── Batch-size heuristics ──

/**
 * Return a fixed or heuristic batch size for streaming, given the file
 * buffer and the caller-supplied config.
 */
export function getStreamingBatchSize(
  buffer: Uint8Array,
  batchConfig: number | DynamicBatchConfig
): number {
  if (typeof batchConfig === 'number') {
    return batchConfig;
  }

  const fileSizeMB = batchConfig.fileSizeMB
    ? batchConfig.fileSizeMB
    : buffer.length / (1024 * 1024);

  return fileSizeMB < 10 ? 100
    : fileSizeMB < 50 ? 200
    : fileSizeMB < 100 ? 300
    : fileSizeMB < 300 ? 500
    : fileSizeMB < 500 ? 1500
    : 3000;
}

// ── WASM collection → MeshData[] conversion ──

/**
 * Convert a WASM MeshCollection into a plain MeshData array, freeing
 * each mesh and the collection itself.
 */
export function convertMeshCollectionToBatch(
  collection: import('@ifc-lite/wasm').MeshCollection
): MeshData[] {
  const batch: MeshData[] = [];

  try {
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      if (!mesh) continue;

      try {
        batch.push({
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
        });
      } finally {
        mesh.free();
      }
    }
  } finally {
    collection.free();
  }

  return batch;
}

/**
 * Convert a WASM InstancedMeshCollection into a plain array of
 * InstancedGeometry objects, freeing the collection wrapper.
 */
export function convertInstancedCollectionToBatch(
  collection: import('@ifc-lite/wasm').InstancedMeshCollection
): import('@ifc-lite/wasm').InstancedGeometry[] {
  const batch: import('@ifc-lite/wasm').InstancedGeometry[] = [];

  try {
    for (let i = 0; i < collection.length; i++) {
      const geometry = collection.get(i);
      if (geometry) {
        batch.push(geometry);
      }
    }
  } finally {
    collection.free();
  }

  return batch;
}

// ── Coordinate-info helpers ──

/**
 * Merge an optional building rotation value into a CoordinateInfo object.
 */
export function withBuildingRotation(
  coordinateInfo: CoordinateInfo,
  buildingRotation?: number
): CoordinateInfo {
  return buildingRotation !== undefined
    ? { ...coordinateInfo, buildingRotation }
    : coordinateInfo;
}
