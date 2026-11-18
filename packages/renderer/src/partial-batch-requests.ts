/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning one colour batch into the set of partial sub-batches that should be
 * drawn for it this frame.
 *
 * A colour batch draws with ONE uniform per draw, so a per-entity colour or
 * alpha that disagrees within a batch has to be expressed by drawing subsets
 * of it. Visibility is not such a property: a partly hidden batch is drawn
 * whole and the GPU discards its hidden entities (`entity-visibility-table.ts`,
 * #10264 S2). Two properties do split, and they compose:
 *
 * - **Colour-override promotion** (#677): an entity carrying a deliberate lens/
 *   Pset override must draw through the OPAQUE pipeline, the only draws the
 *   entity colour table paints (#6076). Promoting the whole
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
import { alphaSlotSuffix, type AlphaGroup, type XRayAlpha } from './xray-alpha.js';

/** One sub-batch the frame wants drawn: a subset of `colorKey`'s batch. */
export interface PartialBatchRequest {
  /** The colour batch this subset is cut from. Drawing the subset counts as
   *  drawing it for residency (#9034), so an on-screen batch never ages out. */
  sourceBatch: BatchedMesh;
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
   * Request `batch` as sub-batches when one uniform cannot draw it: one per
   * X-Ray alpha (#4129), or `:promoted` and `:remaining` for a transparent
   * id set with mixed override membership (#677). Both splits pass the
   * `canPartition` gate (#9220).
   *
   * @param ids Restrict to this subset (the visible ids of a partly hidden
   *            batch), or `null` for the batch's own ids. A subset is cut
   *            from the visible pieces only, so it needs no visibility test.
   * @returns `false` when the batch draws whole from its own buffers: it needs
   *          no split, or it cannot be partitioned (CPU geometry released, a
   *          colour-merged piece, a cold bucket). Hide/isolate alone never
   *          splits: a partly hidden batch is drawn whole and its hidden
   *          entities are discarded on the GPU (#10264 S2). The whole draw is
   *          routed by `shouldRouteBatchTransparent` and faded by the lowest
   *          alpha of `ids`, the pre-#677/#4129 behaviour: a mixed batch stays
   *          transparent and a fade is too wide, never missing or drawn twice.
   */
  pushSplit(batch: BatchedMesh, isTransparent: boolean, ids: Set<number> | null = null): boolean {
    const groups = this.alphaGroups(batch, ids);
    if (groups != null && this.canPartition(batch)) {
      // Groups arrive in a stable order, so a group keeps the same slot across
      // frames while its content is unchanged. Each may split by promotion too.
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        this.emit(batch, mixedPromotion(g.ids, this.colorOverrides, g.alpha < OPAQUE_ALPHA_CUTOFF) ?? g.ids, alphaSlotSuffix(i));
      }
      return true;
    }
    const split = mixedPromotion(ids ?? batch.expressIds, this.colorOverrides, isTransparent);
    if (split == null || !this.canPartition(batch)) return false;
    this.emit(batch, split, '');
    return true;
  }

  /**
   * Whether the X-Ray state or the overrides alone want this batch (or its
   * `ids` subset) split, whether or not its pieces can be partitioned right
   * now. A cold batch cannot be until its pieces are back from disk (#9136).
   */
  wantsSplit(batch: BatchedMesh, isTransparent: boolean, ids: Set<number> | null = null): boolean {
    return this.alphaGroups(batch, ids) != null || mixedPromotion(ids ?? batch.expressIds, this.colorOverrides, isTransparent) != null;
  }

  private alphaGroups(batch: BatchedMesh, ids: Set<number> | null): AlphaGroup[] | null {
    if (!this.xray.active) return null;
    return ids ? this.xray.groupsForIds(ids, batch.color[3]) : this.xray.groupsForBatch(batch, batch.color[3]);
  }

  /**
   * Push one sub-batch for an id set, or `:promoted` and `:remaining` for a
   * promotion split the caller has already gated on `canPartition`. Slots are
   * distinct so the cache can hold both halves at once; the classifier downstream
   * routes each via shouldRouteBatchTransparent.
   *
   * @param keySuffix Distinguishes slots of the same parent (the alpha split
   *                  passes `:xN`); the promotion split appends after it.
   */
  private emit(sourceBatch: BatchedMesh, subset: Set<number> | PromotionSplit, keySuffix: string): void {
    const baseKey = `${sourceBatch.colorKey}:${sourceBatch.id}${keySuffix}`;
    const push = (sourceBatchKey: string, visibleIds: Set<number>): void => {
      this.items.push({ sourceBatch, sourceBatchKey, colorKey: sourceBatch.colorKey, visibleIds, color: sourceBatch.color });
    };
    if (subset instanceof Set) {
      push(baseKey, subset);
      return;
    }
    push(`${baseKey}:promoted`, subset.promoted);
    push(`${baseKey}:remaining`, subset.remaining);
  }
}

type PromotionSplit = NonNullable<ReturnType<typeof splitVisibleIdsByPromotion>>;

/** A transparent id set with both promoted and remaining members (#677), else null. */
function mixedPromotion(ids: Iterable<number>, overrides: RGBAOverrideMap | null, isTransparent: boolean): PromotionSplit | null {
  if (!isTransparent) return null;
  const split = splitVisibleIdsByPromotion(ids, overrides);
  return split != null && split.remaining.size > 0 ? split : null;
}
