/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The layer-stack slice's contribution to viewer-state teardown (#4309).
 *
 * A sibling module rather than a block at the bottom of `layerStackSlice.ts`
 * to match the group convention `store/teardown.ts` documents (sibling file
 * once a slice plus its contribution would grow past the ~400-line ratchet;
 * `splitToolSlice.teardown.ts` is the direct precedent for this same shape).
 *
 * `layerStack` / `layerStackPathToId` / `layerStackDiff` / `layerDiffBusy`
 * hold the IFCX composition behind the Layers panel — each entry keeps the
 * FULL PARSED layer document (`LayerStackEntry.file`), and
 * `layerStackPathToId` is the panel's own doc comment's "3D selection
 * bridge": a `path -> expressId` map into that composition. None of it had a
 * teardown entry before this file. `useIfcFederation.ts`'s
 * `loadFederatedIfcxFromBuffers` is the only production caller of
 * `setLayerStack` (it runs `resetViewerState()` then `clearAllModels()` then
 * repopulates the stack synchronously), so a *fresh* federated load always
 * lands correct — the gap is everything else that can leave a *populated*
 * stack behind:
 *
 *   - `modelSlice.removeModel`, called directly from `LayersPanel.tsx` /
 *     the Models panel, when the removed model is one of THIS composition's
 *     layers. Each federated layer is registered as its own `FederatedModel`
 *     with `id: layer.id` (`useIfcFederation.ts`'s per-layer `storeAddModel`
 *     loop), and `layerStackEntry()` (`lib/layers/stack.ts`) carries that
 *     same `layer.id` into `LayerStackEntry.id` — so a stale layer is
 *     detected by `LayerStackEntry.id === scope.modelId`, not by
 *     `scope.isStale` (a numeric-expressId predicate; `layerStack` entries
 *     are keyed by model id, not by any single express id).
 *   - `clearAllModels()` called on its own, outside a federated (re-)load —
 *     `modelSlice.ts` and `selectionSlice.teardown.ts` both document that
 *     `clearAllModels()` has call sites (e.g. `GeoreferencingPanel.tsx`'s
 *     `reloadModelsForAlignment`) that are not followed by
 *     `resetViewerState()`.
 *   - a non-federated (STEP / single-file / GLB) load's `session-reset`
 *     that is not itself preceded by a federation `clearLayerStack()` call
 *     — belt-and-suspenders with `useIfcLoader.ts`'s explicit call, which
 *     this contribution does not replace: `useIfcLoader.ts` clears eagerly
 *     before parsing so `LayersPanel.tsx` cannot render a moment of a
 *     previous composition beside a loading spinner, while this arm is what
 *     survives any load path that forgets that call.
 *
 * `layersPanelVisible` resets to `false` ONLY on `session-reset`, matching
 * `bcfSlice.teardown.ts` / `idsSlice.teardown.ts` / `sheetSlice.teardown.ts`:
 * a genuinely new file (including a non-IFCX one) should not keep a federated
 * layers panel docked open, but removing one layer out of a live federation,
 * or clearing all models without a fresh load queued right behind it, leaves
 * the panel open over now-empty composition data rather than yanking it
 * closed under the user mid-session — the same choice those three panels
 * already make for `model-removed` / `all-models-cleared`.
 */

import { defineSliceTeardown } from '../teardown.js';

const emptyStackPatch = {
  layerStack: [],
  layerStackPathToId: null,
  layerStackDiff: null,
  layerDiffBusy: false,
} as const;

export const layerStackTeardown = defineSliceTeardown(
  'layerStackSlice',
  ['layerStack', 'layerStackPathToId', 'layerStackDiff', 'layerDiffBusy', 'layersPanelVisible'],
  {
    'session-reset': () => ({
      ...emptyStackPatch,
      layersPanelVisible: false,
    }),
    'model-removed': (scope, state) => {
      const stale = (state.layerStack ?? []).some((entry) => entry.id === scope.modelId);
      if (!stale) return {};
      return emptyStackPatch;
    },
    'all-models-cleared': () => emptyStackPatch,
  },
);
