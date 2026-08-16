/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from './index.js';

export function resetVisibilityForHomeFromStore(): void {
  const state = useViewerStore.getState();
  state.showAllInAllModels();
  state.clearStoreySelection();
  state.clearHierarchyBasketSelection();
  state.clearEntitySelection();
  state.clearBasket();
  // Also drop any focused-clash state so "Show all" / reset filters clears the
  // clash A/B colouring, the contact overlay (lines + box), and the selected row
  // (#1402). The colour-override channel is restored to an active lens, or emptied.
  //
  // `setClashSelectedId(null)` also drops any intersection-solid presentation
  // and bumps `clashSolidRequestSeq` (clashSlice): without that, a resolved
  // (or still in-flight) `focusClash` solid could keep rendering opaque after
  // Home / "Show all" brings the rest of the model back, with nothing selected
  // (#2574 review).
  state.setClashHighlightColors(null);
  state.setClashOverlapBox(null);
  state.setClashContactLines(null);
  state.setClashSelectedId(null);
  state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  useViewerStore.setState({ activeBasketViewId: null });
}

export function goHomeFromStore(): void {
  resetVisibilityForHomeFromStore();
  const state = useViewerStore.getState();
  state.cameraCallbacks.home?.();
}
