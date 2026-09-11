/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning one colour batch into the set of partial sub-batches that should be
 * drawn for it this frame.
 *
 * A colour batch draws with ONE uniform per draw, so any per-entity property
 * that disagrees within a batch has to be expressed by drawing subsets of it.
 * Two such properties exist, and they compose:
 *
 * - **Colour-override promotion** (#677): an entity carrying a deliberate lens/
 *   Pset override must draw through the OPAQUE pipeline so the overlay paint
 *   pass (`depthCompare: 'equal'`) finds depth to match. Promoting the whole
 *   batch would drag non-overridden batchmates opaque, so a mixed batch splits
 *   into `:promoted` and `:remaining`.
 * - **X-Ray alpha** (#4129): `transparencyOverrides` / `ghostExceptIds` name
 *   entities, so a batch whose entities resolve to different alphas splits into
 *   one `:xN` slot per distinct alpha. Otherwise fading one element faded every
 *   batchmate that happened to share its colour.
 *
 * Each emitted entry names a cache SLOT (`sourceBatchKey`). Slots are stable
 * across frames — that is what lets the sub-batch cache hold a clone per slot
 * instead of rebuilding every frame — and distinct, so a batch can own several
 * at once without them overwriting each other.
 */

import type { BatchedMesh } from './types.js';
import { splitVisibleIdsByPromotion, OPAQUE_ALPHA_CUTOFF, type RGBAOverrideMap } from './overlay-routing.js';
import { alphaSlotSuffix, type XRayAlpha } from './xray-alpha.js';

/** One sub-batch the frame wants drawn: a subset of `colorKey`'s batch. */
export interface PartialBatchRequest {
  /** Cache slot this subset belongs to. Stable across frames, unique per subset. */
  sourceBatchKey: string;
  colorKey: string;
  visibleIds: Set<number>;
  color: [number, number, number, number];
}

/**
 * Collects the frame's partial sub-batch requests. One instance per frame — it
 * holds no state beyond the list it is building.
 */
export class PartialBatchRequests {
  readonly items: PartialBatchRequest[] = [];

  /**
   * @param colorOverrides Active lens/Pset overrides, for the promotion split.
   * @param xray           This frame's resolved X-Ray state.
   * @param canPartition   Whether a batch's geometry can be split at all right
   *                       now (`Scene.canPartitionBatch`). Injected rather than
   *                       reached for, so the split logic stays testable without
   *                       a Scene or a GPU.
   */
  constructor(
    private readonly colorOverrides: RGBAOverrideMap | null,
    private readonly xray: XRayAlpha,
    private readonly canPartition: (batch: BatchedMesh) => boolean,
  ) {}

  /** The slots requested so far, for the cache's retire sweep. */
  requestedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const item of this.items) keys.add(item.sourceBatchKey);
    return keys;
  }

  /**
   * Request `visibleIds` of `sourceBatch` as a sub-batch, splitting by override
   * promotion when the batch is transparent and only SOME of those ids carry a
   * deliberate override.
   *
   * @param keySuffix Distinguishes slots of the same parent (the alpha split
   *                  passes `:xN`); the promotion split appends after it.
   */
  pushVisible(
    sourceBatch: BatchedMesh,
    visibleIds: Set<number>,
    isTransparent: boolean,
    keySuffix: string = '',
  ): void {
    const baseKey = `${sourceBatch.colorKey}:${sourceBatch.id}${keySuffix}`;
    const emit = (sourceBatchKey: string, ids: Set<number>): void => {
      this.items.push({
        sourceBatchKey,
        colorKey: sourceBatch.colorKey,
        visibleIds: ids,
        color: sourceBatch.color,
      });
    };
    if (!isTransparent) {
      emit(baseKey, visibleIds);
      return;
    }
    const split = splitVisibleIdsByPromotion(visibleIds, this.colorOverrides);
    // No promotion, or every visible id promoted → one sub-batch; the classifier
    // downstream routes it via shouldRouteBatchTransparent.
    if (split == null || split.remaining.size === 0) {
      emit(baseKey, visibleIds);
      return;
    }
    // Mixed — one promoted (opaque-routed) and one remaining (transparent-routed)
    // sub-batch, on distinct slots so the cache can hold both at once.
    emit(`${baseKey}:promoted`, split.promoted);
    emit(`${baseKey}:remaining`, split.remaining);
  }

  /**
   * Request `batch` as one sub-batch per distinct X-Ray alpha (#4129), so
   * fading one element stops fading its colour batchmates.
   *
   * @param ids Restrict to this subset (the visible subset of a partially
   *            hidden batch), or `null` for the batch's own ids.
   * @returns `false` when the batch must be drawn WHOLE after all — it needs no
   *          split, or its geometry cannot be partitioned. The caller then falls
   *          back to the batch-wide minimum alpha, which is the pre-#4129
   *          behaviour: a fade that is too wide, never missing geometry.
   */
  pushAlphaSplit(batch: BatchedMesh, ids: Set<number> | null): boolean {
    if (!this.xray.active) return false;
    const groups = ids
      ? this.xray.groupsForIds(ids, batch.color[3])
      : this.xray.groupsForBatch(batch, batch.color[3]);
    if (groups == null || !this.canPartition(batch)) return false;
    // Groups arrive in a stable order, so a group keeps the same slot across
    // frames while its content is unchanged.
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      this.pushVisible(batch, g.ids, g.alpha < OPAQUE_ALPHA_CUTOFF, alphaSlotSuffix(i));
    }
    return true;
  }
}
