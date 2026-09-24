/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The active lens's scene effect, mounted once for the viewer's lifetime (#5877).
 *
 * A lens stays active after its panel closes: its colours and hides are scene
 * state, not panel state. Evaluation (`useLens`) and the sync of the lens's
 * hidden ids into the shared `hiddenEntities` channel therefore live here,
 * beside the layout, rather than in `LensPanel` — where they used to stop the
 * moment the panel unmounted, so a model loaded or edited afterwards was never
 * coloured or hidden by the lens that still claimed to be active.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { useLens } from '@/hooks/useLens';
import { planLensHiddenSync } from './lens-visibility-ownership';

const EMPTY_LENS_HIDDEN: ReadonlySet<number> = new Set<number>();

export function LensRuntimeHost(): null {
  useLens();

  const activeLensId = useViewerStore((s) => s.activeLensId);
  // Identity, not `.size`: `useLens` replaces the Set on every recompute, and
  // a same-size content swap must still resync (#5206).
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);

  // planLensHiddenSync computes minimal show/hide deltas plus the ids the lens
  // OWNS afterwards (only ids it newly hid — an id the user manually hid
  // before or during the lens stays hidden after teardown). Ownership is
  // persisted in the store, so a remount re-runs this as a no-op instead of
  // losing track of (or double-claiming) the lens's hides.
  useEffect(() => {
    const state = useViewerStore.getState();
    const plan = planLensHiddenSync({
      applied: state.lensAppliedHiddenIds,
      hiddenEntities: state.hiddenEntities,
      lensHiddenIds: activeLensId ? lensHiddenIds : EMPTY_LENS_HIDDEN,
    });
    if (plan.show.length > 0) state.showEntities(plan.show);
    if (plan.hide.length > 0) state.hideEntities(plan.hide);
    if (plan.nextApplied.length > 0 || state.lensAppliedHiddenIds.length > 0) {
      state.setLensAppliedHiddenIds(plan.nextApplied);
    }
  }, [activeLensId, lensHiddenIds]);

  return null;
}
