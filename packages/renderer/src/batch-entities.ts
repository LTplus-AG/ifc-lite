/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every entity a colour batch draws (#10653).
 *
 * A batch lists one primary id per piece (`expressIds`). A colour-merged piece
 * (`MeshData.entityIds`) also tags vertices with OTHER entities, which the
 * vertex lane carries but `expressIds` does not. Anything that decides per
 * batch from its ids (hide/isolate classification, the lane anchor, X-Ray
 * fade, colour-override routing, the highlight batch search) reads both
 * through {@link batchEntities}, so the decision covers the secondary
 * entities without the CPU pieces. The secondary ids live on the batch as
 * `laneIds`, set by every batch builder and kept through snapshots.
 */

import type { MeshData } from '@ifc-lite/geometry';

/** The part of a batch the entity list reads. */
export interface BatchEntityIds {
  readonly expressIds: readonly number[];
  readonly laneIds?: readonly number[];
  /** Bumped whenever `expressIds` changes, on batches whose ids can also leave (compact pages). */
  readonly entryRevision?: number;
}

/**
 * What a per-batch cache keys its id-derived answer on. A bucket batch only
 * gains ids, so its length says when they changed; a compact page also loses
 * them (a retired mesh), so it counts every change in `entryRevision`.
 */
export function batchEntryStamp(batch: BatchEntityIds): number {
  return batch.entryRevision ?? batch.expressIds.length;
}

/**
 * Sorted unique vertex-lane ids of `meshes` other than each piece's own
 * primary id, or undefined when there are none (every in-tree producer). An id
 * that is also another piece's primary is kept: the piece still hosts that
 * entity's geometry, so the batch is colour-merged and cannot be split by piece.
 */
export function foreignLaneIds(meshes: readonly Pick<MeshData, 'expressId' | 'entityIds'>[]): number[] | undefined {
  let foreign: Set<number> | undefined;
  for (const mesh of meshes) {
    const ids = mesh.entityIds;
    if (!ids) continue;
    for (let i = 0; i < ids.length; i++) if (ids[i] !== mesh.expressId) (foreign ??= new Set()).add(ids[i]!);
  }
  return foreign ? [...foreign].sort((a, b) => a - b) : undefined;
}

/** `{ laneIds }` for a batch built from `meshes`, or nothing: spread into the batch. */
export function laneIdsOf(meshes: readonly Pick<MeshData, 'expressId' | 'entityIds'>[]): { laneIds?: number[] } {
  const laneIds = foreignLaneIds(meshes);
  return laneIds ? { laneIds } : {};
}

const cache = new WeakMap<object, readonly number[]>();

/** Primary and secondary ids of a batch, each once; the primary list itself when it has no secondary ids. */
export function batchEntities(batch: BatchEntityIds): readonly number[] {
  const lanes = batch.laneIds;
  if (!lanes || lanes.length === 0) return batch.expressIds;
  let all = cache.get(batch);
  if (!all) {
    all = [...new Set([...batch.expressIds, ...lanes])];
    cache.set(batch, all);
  }
  return all;
}
