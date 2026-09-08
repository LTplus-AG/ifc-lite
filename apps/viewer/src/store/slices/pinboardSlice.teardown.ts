/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pinboardSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice for the reason
 * `modelSlice.teardown.ts` documents.
 *
 * `clearPinboard` / `clearBasket` are NOT folded in and must not be: both of
 * them also write `isolatedEntities`, which belongs to `visibilitySlice`.
 * Ownership here is disjoint by construction (`createTeardownRegistry` proves
 * it at module init), so the isolation channel is torn down once, by its owner.
 */

import { defineSliceTeardown } from '../teardown.js';
import { stringToEntityRef } from '../types.js';

export const pinboardTeardown = defineSliceTeardown(
  'pinboardSlice',
  [
    'pinboardEntities',
    'hierarchyBasketSelection',
    'basketViews',
    'activeBasketViewId',
    'basketPresentationVisible',
  ],
  {
    'session-reset': () => ({
      // Pinboard - clear pinned entities on new file
      pinboardEntities: new Set<string>(),
      basketViews: [],
      activeBasketViewId: null,
      basketPresentationVisible: false,
      hierarchyBasketSelection: new Set<string>(),
    }),
    // Same dangling-ref shape as the 'model-removed' purge below, for the
    // full-teardown path: with every model gone, every basket ref is stale by
    // definition. `basketViews` / `activeBasketViewId` /
    // `basketPresentationVisible` are NOT in this arm — `clearAllModels` has
    // never written them, and a saved view is a document the user authored,
    // not scene state.
    'all-models-cleared': () => ({
      pinboardEntities: new Set<string>(),
      hierarchyBasketSelection: new Set<string>(),
    }),
    'model-removed': (scope, state) => {
      // Pinboard/basket state is keyed the same way as `selectedEntitiesSet` --
      // Set<string> of "modelId:expressId" entityRef strings. `pinboardEntities`
      // is the basket's SOURCE OF TRUTH: every basket edit
      // (`addToBasket`/`removeFromBasket`/`showPinboard`) re-derives
      // `isolatedEntities` from it via `toGlobalIdForRef`, and
      // `toGlobalIdFromModels` falls back to the RAW, un-offset expressId when a
      // ref's modelId is no longer in `models`. A stale ref surviving removal
      // therefore doesn't just dangle inertly: the next basket operation resolves
      // it to a bare, unscaled global id that can collide with a real entity in
      // any surviving model whose own offset range covers that raw number (any
      // model with idOffset 0, notably) -- silently co-isolating or co-hiding an
      // entity the user never touched.
      const priorPinboard = state.pinboardEntities ?? new Set<string>();
      const priorHierarchyBasket = state.hierarchyBasketSelection ?? new Set<string>();
      const keptPinboard = new Set(
        [...priorPinboard].filter((k) => stringToEntityRef(k).modelId !== scope.modelId),
      );
      const keptHierarchyBasket = new Set(
        [...priorHierarchyBasket].filter((k) => stringToEntityRef(k).modelId !== scope.modelId),
      );

      // Nothing of ours belonged to the removed model: return {} rather than two
      // equal-but-new Sets. `syncSourceModel` runs this same scope again
      // straight after `removeModel`, and a fresh reference there would re-notify
      // every basket subscriber for a set that did not move.
      if (
        keptPinboard.size === priorPinboard.size &&
        keptHierarchyBasket.size === priorHierarchyBasket.size
      ) {
        return {};
      }

      return { pinboardEntities: keptPinboard, hierarchyBasketSelection: keptHierarchyBasket };
    },
  },
);
