/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A geometry worker's batch message as the main thread's meshes: the two
 * transport encodings a worker may have applied are undone here, in one place.
 */

import { adoptCompactMeshes } from './compact-mesh.js';
import type { CompactPayload } from './compact-geometry.js';
import { unpackFlatBatch } from './flat-batch-pack.js';
import type { MeshData } from './types.js';

export { processBatchBounds } from './compact-mesh.js';

/** The message fields that carry a batch's meshes. */
interface BatchMeshFields {
  meshes: unknown;
  flatVertices?: Parameters<typeof unpackFlatBatch>[1];
  compactBatches?: CompactPayload[];
}

/**
 * The batch's meshes, in place: f32 arrays re-viewed over the packed vertex
 * buffers (`flat-batch-pack.ts`), and compact meshes made shells over their
 * payloads (`compact-mesh.ts`).
 */
export function unpackBatchMeshes(msg: BatchMeshFields): MeshData[] {
  const meshes = unpackFlatBatch(msg.meshes as MeshData[], msg.flatVertices);
  adoptCompactMeshes(meshes, msg.compactBatches);
  return meshes;
}

/** The message fields that carry a batch's GPU-instanced occurrences. */
interface BatchInstancingFields {
  instancedShards?: ArrayBuffer[];
  instancedOccurrences?: number;
  instancedGeometryHashIds?: Uint32Array;
  instancedGeometryHashValues?: BigUint64Array;
  instancedGeometryAabbValues?: Float64Array;
  instancedGeometryVolumeValues?: Float64Array;
}

/**
 * The batch's instanced half as the pool forwards it. Opaque repeated
 * occurrences render only through per-batch IFNS shards, so `occurrences`
 * counts them toward the running total although they are not flat meshes.
 *
 * `fields` is what the batch event carries: the shards when there are any, and
 * the geometry-diff hashes of instanced-only entities (#924) with their world
 * boxes (#1891, six values per id) and proved volumes (#1993, one per id).
 * Boxes and volumes travel with the ids or not at all: an array without its id
 * array indexes nothing.
 */
export function unpackBatchInstancing(msg: BatchInstancingFields): { present: boolean; occurrences: number; fields: BatchInstancingFields } {
  const { instancedShards, instancedGeometryHashIds, instancedGeometryHashValues, instancedGeometryAabbValues, instancedGeometryVolumeValues } = msg;
  const shards = instancedShards !== undefined && instancedShards.length > 0;
  const hashes = instancedGeometryHashIds !== undefined && instancedGeometryHashIds.length > 0;
  return {
    present: shards || hashes,
    occurrences: msg.instancedOccurrences ?? 0,
    fields: {
      ...(shards ? { instancedShards } : {}),
      ...(hashes
        ? {
            instancedGeometryHashIds,
            instancedGeometryHashValues,
            ...(instancedGeometryAabbValues ? { instancedGeometryAabbValues } : {}),
            ...(instancedGeometryVolumeValues ? { instancedGeometryVolumeValues } : {}),
          }
        : {}),
    },
  };
}
