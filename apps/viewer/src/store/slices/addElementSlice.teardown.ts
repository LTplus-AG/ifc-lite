/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `addElementSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice so the whole group has one
 * shape; see `modelSlice.teardown.ts` for why the shape exists.
 *
 * Only the two model-scoped pins are owned here. The panel's form state (type,
 * per-type dimensions, slab mode) and the in-progress click queue are NOT
 * federation state and no teardown path has ever written them, so they are
 * absent from `owns` as well as from the bodies (Trap A: `owns` is the list of
 * everything this slice is willing to destroy).
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const addElementTeardown = defineSliceTeardown('addElementSlice', ['addElementModelId', 'addElementStoreyId'], {
  // `resetViewerState` has never touched these — verified against
  // store/index.ts, which names neither. A file load leaves the panel's pin
  // alone; only a federation change can invalidate it.
  'session-reset': notApplicable,
  // The AddElement panel's "target model" pin is a dangling reference of the
  // same shape as the selection fields, just on a different slice:
  // `addElementModelId` names a specific federated model so the panel and the
  // click-placement handlers (`resolveAddElementContext` in
  // selectionHandlers.ts) stop tracking whichever model is merely active.
  // Nothing else clears it when that model goes away, so it keeps naming a
  // model no longer in `models` after removal — the panel's Select renders
  // blank instead of falling back to the active model, and every subsequent
  // placement click fails with "No model loaded for id" until the user
  // re-picks a model by hand. `addElementStoreyId` is an express id local to
  // that same model, so it is stale too and reset alongside it; it is left
  // alone when the pin names a different (surviving) model, matching how the
  // selection purge only drops entries belonging to the removed model.
  'model-removed': (scope, state) => {
    if (state.addElementModelId !== scope.modelId) return {};
    return { addElementModelId: null, addElementStoreyId: null };
  },
  // With `models` about to become empty there is no federated model left for
  // the pin to name, so it and the model-local storey id go too.
  'all-models-cleared': () => ({ addElementModelId: null, addElementStoreyId: null }),
});
