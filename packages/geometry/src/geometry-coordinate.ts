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
    // Per-entity geometry hashes — only populated when hashing was enabled via
    // `IfcAPI.setComputeGeometryHashes` (issue #924); otherwise the parallel
    // arrays are empty and this Map stays empty (zero overhead). Read inside the
    // try so `collection.free()` in the finally still runs if extraction throws.
    const geometryHashes = extractGeometryHashes(collection);

    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      if (!mesh) continue;

      try {
        // Optional SurfaceColour for the GLB exporter's "Shading" mode.
        // Mirrors the copy in IfcLiteMeshCollector — absent when the file
        // didn't author a distinct DiffuseColour (the common case).
        const shadingArray = (mesh as { shadingColor?: ArrayLike<number> }).shadingColor;
        const shadingColor: [number, number, number, number] | undefined =
          shadingArray && shadingArray.length === 4
            ? [shadingArray[0], shadingArray[1], shadingArray[2], shadingArray[3]]
            : undefined;

        // Read each WASM copy-to-JS getter once; indexing the getter
        // directly would copy a fresh Float32Array out of WASM per access.
        const color = mesh.color;
        const geometryHash = geometryHashes.get(mesh.expressId);
        const meshData: MeshData = {
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          color: [color[0], color[1], color[2], color[3]],
          ...(shadingColor ? { shadingColor } : {}),
        };

        // #961: copy the Rust-decoded surface texture + per-vertex UVs (the
        // getters return empty for the ~all untextured meshes). The browser
        // only uploads `rgba` to a GPU texture — no image decoding in JS.
        if ((mesh as { hasTexture?: boolean }).hasTexture) {
          meshData.uvs = mesh.uvs;
          meshData.texture = {
            rgba: mesh.textureRgba,
            width: mesh.textureWidth,
            height: mesh.textureHeight,
            repeatS: mesh.textureRepeatS,
            repeatT: mesh.textureRepeatT,
          };
        }

        // #924: attach the per-entity geometry fingerprint (empty Map → no-op
        // unless geometry hashing was enabled).
        if (geometryHash !== undefined) meshData.geometryHash = geometryHash;

        batch.push(meshData);
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
 * Read the per-entity geometry fingerprints off a WASM MeshCollection into a
 * `Map<expressId, bigint>`. The collection exposes two parallel arrays
 * (`geometryHashIds` ↔ `geometryHashValues`); both are empty unless hashing
 * was enabled via `IfcAPI.setComputeGeometryHashes`. Must be called before
 * `collection.free()`. Tolerates an older WASM build lacking the getters
 * (returns an empty Map) so the geometry path never breaks.
 */
function extractGeometryHashes(
  collection: import('@ifc-lite/wasm').MeshCollection
): Map<number, bigint> {
  const map = new Map<number, bigint>();
  const c = collection as unknown as {
    geometryHashCount?: number;
    geometryHashIds?: Uint32Array;
    geometryHashValues?: BigUint64Array;
  };
  const count = c.geometryHashCount ?? 0;
  if (count === 0) return map;

  const ids = c.geometryHashIds;
  const values = c.geometryHashValues;
  if (!ids || !values) return map;

  const n = Math.min(ids.length, values.length);
  for (let i = 0; i < n; i++) {
    map.set(ids[i], values[i]);
  }
  return map;
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
