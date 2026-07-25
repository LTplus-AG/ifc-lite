/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drives `decideRibbonTab` from live store state. Mounted by RibbonToolbar,
 * so the classic strip pays nothing for it.
 *
 * Two things live here rather than in the pure policy: the edge detection
 * (previous context in a ref) and "the user took the wheel" — any tab change
 * we did not make ourselves drops the return memory, so a hand-picked tab is
 * never yanked back when the selection clears.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { useTourStore } from '@/lib/tours/tour-store';
import {
  decideRibbonTab,
  NO_TAB_MEMORY,
  type RibbonContext,
  type RibbonTabMemory,
} from './contextual-tabs';

export function useRibbonContextualTab(): void {
  const enabled = useViewerStore((s) => s.ribbonContextualTabs);
  const ribbonTab = useViewerStore((s) => s.ribbonTab);
  const setRibbonTab = useViewerStore((s) => s.setRibbonTab);
  const hasModel = useViewerStore((s) => s.models.size > 0);
  const hasSelection = useViewerStore((s) => s.selectedEntityIds.size > 0);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  // A running walkthrough drives the tabs itself; contextual switching would
  // fight it (and move the spotlight target mid-step).
  const tourIdle = useTourStore((s) => s.status === 'idle');

  const prevRef = useRef<RibbonContext | null>(null);
  const memoryRef = useRef<RibbonTabMemory>(NO_TAB_MEMORY);

  useEffect(() => {
    const next: RibbonContext = { hasModel, hasSelection, editEnabled };

    // Keep the baseline current even while suspended, so re-enabling never
    // replays a stale edge (e.g. a selection made during a tour).
    if (!enabled || !tourIdle) {
      prevRef.current = next;
      memoryRef.current = NO_TAB_MEMORY;
      return;
    }

    // The user moved off the tab we opened: their choice now owns the strip.
    if (memoryRef.current.autoOpened && memoryRef.current.autoOpened !== ribbonTab) {
      memoryRef.current = NO_TAB_MEMORY;
    }

    const decision = decideRibbonTab(prevRef.current, next, ribbonTab, memoryRef.current);
    prevRef.current = next;
    if (!decision) return;
    memoryRef.current = decision.memory;
    if (decision.tab !== ribbonTab) setRibbonTab(decision.tab);
  }, [enabled, tourIdle, hasModel, hasSelection, editEnabled, ribbonTab, setRibbonTab]);
}
