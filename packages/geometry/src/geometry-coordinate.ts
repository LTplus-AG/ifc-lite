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
        // Per-element local-frame origin (world = origin + position); [0,0,0] or
        // absent getter (older bundle) → absolute positions.
        const originArr = (mesh as { origin?: ArrayLike<number> }).origin;
        const origin: [number, number, number] | undefined =
          originArr && originArr.length === 3 && (originArr[0] || originArr[1] || originArr[2])
            ? [originArr[0], originArr[1], originArr[2]]
            : undefined;
        // Local (pre-placement) AABB + placement transform (issue #1474);
        // absent on older bundles (no getter) or when not captured (e.g. an
        // instancing template).
        const localBoundsArr = (mesh as { localBounds?: ArrayLike<number> }).localBounds;
        const localBounds =
          localBoundsArr && localBoundsArr.length === 6
            ? {
                min: [localBoundsArr[0], localBoundsArr[1], localBoundsArr[2]] as [number, number, number],
                max: [localBoundsArr[3], localBoundsArr[4], localBoundsArr[5]] as [number, number, number],
              }
            : undefined;
        const localToWorldArr = (mesh as { localToWorld?: ArrayLike<number> }).localToWorld;
        const localToWorld =
          localToWorldArr && localToWorldArr.length === 16 ? Array.from(localToWorldArr) : undefined;
        const meshData: MeshData = {
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          color: [color[0], color[1], color[2], color[3]],
          ...(shadingColor ? { shadingColor } : {}),
          ...(origin ? { origin } : {}),
          ...(localBounds ? { localBounds } : {}),
          ...(localToWorld ? { localToWorld } : {}),
          // #957 follow-up: carry the Model/Types geometry class so the viewer's
          // view-mode filter can show/hide type-library geometry.
          geometryClass: (mesh as { geometryClass?: number }).geometryClass ?? 0,
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
        } else if ((mesh as { textureUrl?: string }).textureUrl) {
          // #1781: external image reference (`IfcImageTexture`) — carry the
          // lightweight ref; the viewer resolves it against the `.ifcZIP`
          // sibling images and decodes once per textureId.
          meshData.uvs = mesh.uvs;
          meshData.textureRef = {
            textureId: (mesh as unknown as { textureId: number }).textureId,
            url: (mesh as unknown as { textureUrl: string }).textureUrl,
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
