/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useOverlayCompositor — reconciles the registered overlay layers into the
 * renderer's legacy channels (`hiddenEntities`, `pendingColorUpdates`).
 *
 * Responsibility split after P4:
 *   • Layer owners (animation, future: gantt-selection, lens, user-isolation)
 *     call `registerOverlayLayer(...)` / `removeOverlayLayer(id)` to declare
 *     their desired contribution. They do NOT write to the legacy channels.
 *   • This hook is the SINGLE writer to those legacy channels. It watches
 *     the overlay registry, computes the composite, and writes a delta.
 *
 * Ownership tracking lives here exactly once — previously duplicated as
 * `contributedHiddenRef` / `contributedColorsRef` inside every consumer.
 *
 * This hook must be mounted high in the viewer tree so it runs throughout
 * the session. Mount it alongside the root viewport or the Gantt panel.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';

export function useOverlayCompositor(): void {
  // Each entry is a GLOBAL id we hid; flag = "was already hidden by user
  // when we took over". On restore we only un-hide ids where `false`.
  const contributedHiddenRef = useRef<Map<number, boolean>>(new Map());
  // Global ids we last wrote as colour overrides. Used to know when we
  // need to issue a clear (`setPendingColorUpdates(new Map())`).
  const contributedColorsRef = useRef<Set<number>>(new Set());

  const overlayLayers = useViewerStore((s) => s.overlayLayers);

  useEffect(() => {
    const store = useViewerStore.getState();

    // Build composite hiddenIds + colorOverrides from the current layers.
    // `composeLayers` is a pure function — the hook decides when to rerun.
    const { hiddenIds: nextHidden, colorOverrides: nextColors } = store.computeCompositeOverlay();

    // ── Reconcile hidden set ──────────────────────────────────────────
    //
    // Compare the new hidden set against what we last wrote, not against
    // the store's current `hiddenEntities` (which includes user-isolated
    // ids we don't own). `contributedHiddenRef` maps each id we last hid
    // to a boolean: "was the user already hiding this before we wrote?".
    // On restore, only un-hide ids whose flag is false.
    const prev = contributedHiddenRef.current;
    const toShow: number[] = [];
    for (const [id, wasHidden] of prev) {
      if (!nextHidden.has(id) && wasHidden === false) toShow.push(id);
    }
    const toHide: number[] = [];
    const nextHiddenMap = new Map<number, boolean>();
    const currentlyHidden = store.hiddenEntities ?? new Set<number>();
    for (const id of nextHidden) {
      if (prev.has(id)) {
        // We still want this id hidden AND we already wrote it — preserve
        // the "was already hidden" bit so we un-hide correctly later.
        nextHiddenMap.set(id, prev.get(id)!);
      } else {
        // First time we see this id. Capture whether the user already had
        // it hidden so we won't unhide their choice on teardown.
        const wasHidden = currentlyHidden.has(id);
        nextHiddenMap.set(id, wasHidden);
        if (!wasHidden) toHide.push(id);
      }
    }
    if (toShow.length > 0) store.showEntities(toShow);
    if (toHide.length > 0) store.hideEntities(toHide);
    contributedHiddenRef.current = nextHiddenMap;

    // ── Reconcile colour overrides ────────────────────────────────────
    //
    // Colour overrides are all-or-nothing per call: `setPendingColorUpdates`
    // replaces the full map. When the composite is empty and we had
    // contributions, signal a clear with `new Map()`.
    if (nextColors.size > 0) {
      store.setPendingColorUpdates(nextColors);
      contributedColorsRef.current = new Set(nextColors.keys());
    } else if (contributedColorsRef.current.size > 0) {
      store.setPendingColorUpdates(new Map());
      contributedColorsRef.current = new Set();
    }
  }, [overlayLayers]);

  // Unmount cleanup — restore every id we own, clear our colour overrides.
  // Happens once at app teardown in practice.
  useEffect(() => {
    return () => {
      const store = useViewerStore.getState();
      if (contributedHiddenRef.current.size > 0) {
        const toShow: number[] = [];
        for (const [id, wasHidden] of contributedHiddenRef.current) {
          if (wasHidden === false) toShow.push(id);
        }
        if (toShow.length > 0) store.showEntities(toShow);
        contributedHiddenRef.current = new Map();
      }
      if (contributedColorsRef.current.size > 0) {
        store.setPendingColorUpdates(new Map());
        contributedColorsRef.current = new Set();
      }
    };
  }, []);
}
