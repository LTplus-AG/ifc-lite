/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelSlice`'s contribution to the store-wide teardown seam (`store/teardown.ts`).
 *
 * Beside the slice rather than inside it: `modelSlice.ts` carries a recorded
 * budget in `scripts/module-size-allowlist.txt`, and that ratchet lets a listed
 * file shrink by default; growth is a raise, stated in the PR. Every slice in
 * this group is split the same way so the registry imports one shape, not two.
 *
 * The federation registry is NOT touched here. `federationRegistry
 * .unregisterModel` (partial removal, which BURNS the freed offset range) and
 * `federationRegistry.clear()` (full clear, which resets the offset counter to
 * 0 and is the reason several other slices clear unconditionally on
 * `all-models-cleared`) are side effects, and a teardown is pure — they stay in
 * the entry point, in today's order.
 */

import { defineSliceTeardown } from '../teardown.js';

export const modelTeardown = defineSliceTeardown('modelSlice', ['models', 'activeModelId'], {
  // `resetViewerState` deliberately does NOT clear `models` — "use
  // clearAllModels() for that" (store/index.ts). A file load swaps the
  // ACTIVE model; the federation itself survives it.
  //
  // `activeModelId` DOES null here (#4159 fix), unlike `models`. Every
  // production call site pairs `resetViewerState()` with an immediate
  // `clearAllModels()` in the same synchronous tick — which already nulls
  // `activeModelId` a moment later — so this is not a behaviour change for
  // any of them, only a removal of the moment in between. That moment in
  // between was a real bug: the composed 'session-reset' patch wipes several
  // slices' fields (e.g. drawing2DSlice's `measure2DResults`) to their
  // defaults in this SAME `set()` call, and with `activeModelId` left
  // pointing at the OUTGOING model, any code subscribed to the store —
  // `useDrawing2DPersistence.ts`'s save subscription, concretely — reads a
  // state that looks like "the still-active model's markup was just cleared
  // by the user" and persists the wipe over that model's saved data. Nulling
  // it here closes that window instead of asking every subscriber to guess
  // whether a field change was a reset.
  'session-reset': () => ({ activeModelId: null }),
  'all-models-cleared': () => ({ models: new Map(), activeModelId: null }),
  'model-removed': (scope, state) => {
    const models = state.models;
    // A removal that removes nothing must do nothing. `syncSourceModel` and the
    // collab room teardown can both re-enter with an id that has already gone,
    // and every cleanup below is keyed to THIS model (#2654 second review).
    // This guard is what makes THIS slice's contribution a no-op on the second
    // run: `syncSourceModel` dispatches model-removed again straight after
    // `removeModel`, and the model is gone from `models` by then. The
    // COMPOSITION is deliberately not a no-op there - the second scope is
    // stricter (`notYetASurvivor`) and drops ids the first pass kept, which is
    // the whole reason both runs exist. See `syncSourceModel`'s call site.
    if (!models?.has(scope.modelId)) return {};

    const nextModels = new Map(models);
    nextModels.delete(scope.modelId);

    // The successor is resolved once by `modelRemovedScope`, not here: it is
    // federation knowledge, and `dataSlice` has to follow the same answer to
    // keep `ifcDataStore` / `geometryResult` pointing at the model this names.
    return { models: nextModels, activeModelId: scope.nextActiveModelId };
  },
});
