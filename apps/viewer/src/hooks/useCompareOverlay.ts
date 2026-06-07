/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Applies the model-comparison result to the 3D viewport (issue #924):
 * per-entity colour overrides (added/modified/deleted/unchanged) plus a hidden
 * set that suppresses the duplicated base-model geometry.
 *
 * Colours go through the same single overlay channel `useLens` uses
 * (`setPendingColorUpdates` → `scene.setColorOverrides` — overlay batches drawn
 * over the original geometry, instant to clear). The hidden set is reconciled
 * with ownership tracking lifted from `useOverlayCompositor`: we remember which
 * ids we hid and whether the user had already hidden them, so teardown only
 * un-hides what we actually contributed.
 *
 * Mounted inside `ComparePanel`, so closing the panel (or clearing the result)
 * restores the scene automatically.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { buildCompareOverlay } from '@/lib/compare/overlay';

type ViewerStore = ReturnType<typeof useViewerStore.getState>;

/** Hand the shared colour channel back to its prior owner when compare lets go:
 *  if a lens is still active, restore its overlay; otherwise clear. Prevents the
 *  compare panel from blanking lens colours on close (an active lens only has
 *  its panel hidden, not deactivated). */
function handBackColorChannel(store: ViewerStore): void {
  const lensColors = store.lensAppliedColors;
  store.setPendingColorUpdates(lensColors && lensColors.size > 0 ? new Map(lensColors) : new Map());
}

/** Re-show ids we hid that the user wasn't already hiding, then drop ownership. */
function restoreOwnedHidden(owned: Map<number, boolean>, store: ViewerStore): void {
  if (owned.size === 0) return;
  const toShow: number[] = [];
  for (const [id, wasHidden] of owned) {
    if (wasHidden === false) toShow.push(id);
  }
  if (toShow.length > 0) store.showEntities(toShow);
  owned.clear();
}

/** Reconcile the desired hidden set against what we previously contributed. */
function reconcileHidden(
  nextHidden: Set<number>,
  ownedRef: { current: Map<number, boolean> },
  store: ViewerStore,
): void {
  const prev = ownedRef.current;
  const currentlyHidden = store.hiddenEntities ?? new Set<number>();

  const toShow: number[] = [];
  for (const [id, wasHidden] of prev) {
    if (!nextHidden.has(id) && wasHidden === false) toShow.push(id);
  }

  const next = new Map<number, boolean>();
  const toHide: number[] = [];
  for (const id of nextHidden) {
    if (prev.has(id)) {
      next.set(id, prev.get(id)!);
    } else {
      const wasHidden = currentlyHidden.has(id);
      next.set(id, wasHidden);
      if (!wasHidden) toHide.push(id);
    }
  }

  if (toShow.length > 0) store.showEntities(toShow);
  if (toHide.length > 0) store.hideEntities(toHide);
  ownedRef.current = next;
}

export function useCompareOverlay(): void {
  // global id → "was the user already hiding this when we took over?"
  const ownedHiddenRef = useRef<Map<number, boolean>>(new Map());
  const colorActiveRef = useRef(false);

  const compareResult = useViewerStore((s) => s.compareResult);
  const showUnchanged = useViewerStore((s) => s.compareShowUnchanged);

  useEffect(() => {
    const store = useViewerStore.getState();

    if (!compareResult) {
      if (colorActiveRef.current) {
        handBackColorChannel(store);
        colorActiveRef.current = false;
      }
      restoreOwnedHidden(ownedHiddenRef.current, store);
      return;
    }

    const { colorOverrides, hiddenIds } = buildCompareOverlay(compareResult.diff, showUnchanged);
    reconcileHidden(hiddenIds, ownedHiddenRef, store);
    // Empty map signals the consumer to clear overlays (lens contract).
    store.setPendingColorUpdates(colorOverrides);
    // We own the colour channel whenever a comparison is shown — even an empty
    // override map clobbered any prior lens colours — so teardown must hand the
    // channel back regardless of the map size (don't gate on `.size`).
    colorActiveRef.current = true;
  }, [compareResult, showUnchanged]);

  // Teardown on unmount (panel closed) — restore the scene we touched.
  useEffect(() => {
    return () => {
      const store = useViewerStore.getState();
      if (colorActiveRef.current) {
        handBackColorChannel(store);
        colorActiveRef.current = false;
      }
      restoreOwnedHidden(ownedHiddenRef.current, store);
    };
  }, []);
}
