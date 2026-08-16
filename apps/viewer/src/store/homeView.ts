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
  // `clearClashFocus()` is the clash slice's one complete spelling of that
  // teardown — the tint, the marker, the solid, the selected id and the
  // `clashSolidRequestSeq` bump. Without the bump, a resolved (or still
  // in-flight) `focusClash` solid could keep rendering opaque after Home /
  // "Show all" brings the rest of the model back, with nothing selected
  // (#2574 review). Called rather than re-listing the fields so this path
  // cannot drift out of sync with the others (#2654 review).
  state.clearClashFocus();
  state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  useViewerStore.setState({ activeBasketViewId: null });
}

export function goHomeFromStore(): void {
  resetVisibilityForHomeFromStore();
  const state = useViewerStore.getState();
  state.cameraCallbacks.home?.();
}
