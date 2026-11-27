/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model's next backing generation, built from its current store list WITHOUT
 * restoring released CPU arrays (#10264). Resident meshes are taken as they
 * are. A released mesh (or a scalar-edited copy of one, e.g. a recolour) is
 * answered by its record in the PREVIOUS generation, read one chunk at a time,
 * with the store mesh's current scalar fields (colour, origin, ids, ...) laid
 * over the record's arrays. Memory stays one chunk plus one batch.
 *
 * Edits that rewrite a released mesh's ARRAYS cannot be represented this way
 * (there is nothing in memory to rewrite); such edits are refused upstream
 * (`released-geometry-edits.ts`) rather than silently lost.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { cpuMeshAliases } from '@/lib/geometry-cpu-aliases';
import { isReleasedMesh, releasedAncestry } from '@/lib/released-mesh-provenance';
import type { MeshLease } from './backing-reader';
import type { ModelGeometryBacking } from './geometry-backing-registry';
import { GeometryUnavailableError } from './geometry-readback';
// One field list and one semantics for every readback.
import { mergeReleased } from './store-mesh-readback';

export interface PreviousGeneration { meshes: readonly MeshData[] | undefined; backing: ModelGeometryBacking | undefined }

/** Batches of the next generation's meshes, in store order. */
export async function* replayStoreList(
  list: readonly MeshData[], previous: PreviousGeneration, batchSize = 256, signal?: AbortSignal,
): AsyncGenerator<MeshData[]> {
  const index = new Map<MeshData, number>();
  (previous.meshes ?? []).forEach((mesh, i) => index.set(mesh, i));
  // An undo can restore an ancestor of the acknowledged copy. Index that
  // direction too; direct members retain priority over an ancestor alias.
  (previous.meshes ?? []).forEach((mesh, i) => {
    for (const source of releasedAncestry(mesh)) if (!index.has(source)) index.set(source, i);
  });
  const backing = previous.backing;
  const starts: number[] = [];
  let total = 0;
  for (const chunk of backing?.directory.chunks ?? []) { starts.push(total); total += chunk.meshCount; }
  let held: { chunk: number; lease: MeshLease } | undefined;
  const recordAt = async (at: number): Promise<MeshData> => {
    // The acknowledged source is superseded the moment the store replaced it (consumers stop reading it), but it
    // stays durable for exactly this replay until the replacement commits: read it through the tap's own reader.
    if (!backing?.isDurablyComplete || total !== (previous.meshes?.length ?? -1)) {
      throw new GeometryUnavailableError('The previous backing generation cannot answer for released meshes');
    }
    let chunk = starts.length - 1;
    while (chunk > 0 && starts[chunk] > at) chunk--;
    if (held?.chunk !== chunk) {
      held?.lease.release();
      held = { chunk, lease: await backing.carryReader.leaseChunks([chunk], { signal }) };
    }
    return held.lease.meshes[at - starts[chunk]];
  };
  const previousIndex = (mesh: MeshData): number | undefined => {
    const own = index.get(mesh);
    if (own !== undefined) return own;
    // A copy made after release (a recolour) shares no buffer with its source: follow its ancestry.
    for (const source of releasedAncestry(mesh)) {
      const at = index.get(source);
      if (at !== undefined) return at;
    }
    for (const alias of cpuMeshAliases(mesh)) {
      const at = index.get(alias);
      if (at !== undefined) return at;
    }
    return undefined;
  };
  try {
    let batch: MeshData[] = [];
    for (const mesh of list) {
      if (!isReleasedMesh(mesh)) batch.push(mesh);
      else {
        const at = previousIndex(mesh);
        if (at === undefined) throw new GeometryUnavailableError(`Released mesh of entity ${mesh.expressId} has no backed record to carry`);
        batch.push(mergeReleased(mesh, await recordAt(at)));
      }
      if (batch.length >= batchSize) { yield batch; batch = []; }
    }
    if (batch.length > 0) yield batch;
  } finally {
    held?.lease.release();
  }
}
