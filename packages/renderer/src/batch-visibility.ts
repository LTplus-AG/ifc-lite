/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a colour batch stands under hide/isolate, shared by the colour and
 * shadow passes so both draw the same thing (#2670, #10264 S2).
 *
 * - `'none'`: every entry is hidden; the batch is not drawn and does not cast.
 * - `'all'`: no filter, or every entry visible; drawn from its own buffers.
 * - a {@link PartlyVisibleBatch}: drawn whole from its own buffers with the
 *   per-fragment test against the GPU visibility table
 *   (`entity-visibility-table.ts`). No sub-batch is cut from the CPU copy of
 *   the geometry, so this keeps working once that copy is released.
 *
 * Classification reads the batch's entries (`expressIds`, one per piece). The
 * GPU test reads the vertex lane, so it hides a colour-merged piece's
 * secondary entities exactly where the entries cannot see them; a batch whose
 * entries are all hidden is still skipped whole.
 */

import { isEntityVisible } from './entity-visibility.js';
import { batchEntityIdAnchor } from './entity-color-table.js';
import type { BatchedMesh } from './types.js';
import type { AlphaBatchLike } from './xray-alpha.js';

/**
 * The visible part of a partly hidden batch. Stable for one visibility epoch,
 * so X-Ray's per-object caches resolve its fade once, over the visible
 * entries only, as they would for a sub-batch of them.
 */
export interface PartlyVisibleBatch extends AlphaBatchLike {
  readonly visibleIds: Set<number>;
}

export type BatchVisibility = 'none' | 'all' | PartlyVisibleBatch;

export function classifyBatch(
  batch: Pick<BatchedMesh, 'expressIds' | 'color'>,
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): BatchVisibility {
  if ((hiddenIds == null || hiddenIds.size === 0) && isolatedIds == null) return 'all';
  const visibleIds = new Set<number>();
  let visibleEntries = 0;
  for (const id of batch.expressIds) {
    if (isEntityVisible(id, hiddenIds, isolatedIds)) { visibleIds.add(id); visibleEntries++; }
  }
  if (visibleIds.size === 0) return 'none';
  if (visibleEntries === batch.expressIds.length) return 'all';
  return { expressIds: [...visibleIds], color: batch.color, visibleIds };
}

/**
 * Whether a partly hidden batch can be drawn whole with the GPU test: the
 * table holds this frame's sets, and the batch has a lane anchor to resolve
 * full ids (its entries lie in one 2^24 page, true of every scene batch).
 * Otherwise the batch must be left out, never drawn with its hidden entities.
 */
export function canFilterOnGpu(batch: Pick<BatchedMesh, 'expressIds'>, tableReady: boolean): boolean {
  return tableReady && batchEntityIdAnchor(batch) !== null;
}

/**
 * Per-batch classification cached for one visibility epoch: the O(entries)
 * scan runs once per hide/isolate change, not per frame. A WeakMap, so
 * residency churn while one epoch holds does not pin dead batch objects.
 */
export class BatchVisibilityCache {
  private epoch = -1;
  private cache = new WeakMap<BatchedMesh, BatchVisibility>();

  classify(
    batch: BatchedMesh,
    epoch: number,
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
  ): BatchVisibility {
    if (epoch !== this.epoch) {
      this.cache = new WeakMap();
      this.epoch = epoch;
    }
    let vis = this.cache.get(batch);
    if (vis === undefined) {
      vis = classifyBatch(batch, hiddenIds, isolatedIds);
      this.cache.set(batch, vis);
    }
    return vis;
  }
}
