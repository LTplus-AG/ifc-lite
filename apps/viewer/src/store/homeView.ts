/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from './index.js';
import { resetVisibilityReasons } from '@/lib/visibility/visibility-reasons';
import { trackUiEvent } from '@/lib/analytics';
import type { ViewResetTrigger } from '@/lib/analytics-ui-events';

/** `trigger` names the entry point for the `view_reset` event (#5618). */
export function resetVisibilityForHomeFromStore(trigger: ViewResetTrigger): void {
  trackUiEvent('view_reset', { trigger });
  // Every mechanism the reason table marks `cleared`; the ones it keeps (an
  // active lens, the class-type toggles, the view mode, host types) stay and
  // are named there (#5869).
  resetVisibilityReasons(useViewerStore);
  const state = useViewerStore.getState();
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
  resetVisibilityForHomeFromStore('home');
  const state = useViewerStore.getState();
  state.cameraCallbacks.home?.();
}
