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
