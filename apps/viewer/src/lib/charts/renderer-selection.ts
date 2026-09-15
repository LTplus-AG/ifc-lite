/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

/**
 * Keep logical chart selection in the store without letting the renderer's
 * ordinary blue selection pass cover the chart's own bucket colour (#4832).
 *
 * Only ids owned by the live chart slice are suppressed. Any independent
 * selection remains highlighted, and disabling "Colour in 3D" restores the
 * normal selection presentation without changing selection state.
 */
export function chartAwareRendererSelection(
  selectedId: number | null,
  selectedIds: ReadonlySet<number> | undefined,
  chartColorIn3D: boolean,
  chartSlice: ReadonlySet<number> | null,
): { selectedId: number | null; selectedIds: Set<number> } {
  if (!chartColorIn3D || chartSlice === null) {
    return { selectedId, selectedIds: new Set(selectedIds ?? []) };
  }
  const visibleHighlightIds = new Set<number>();
  for (const id of selectedIds ?? []) {
    if (!chartSlice.has(id)) visibleHighlightIds.add(id);
  }
  return {
    selectedId: selectedId !== null && chartSlice.has(selectedId) ? null : selectedId,
    selectedIds: visibleHighlightIds,
  };
}

/** Resolve the render-only selection against the live chart presentation. */
export function chartAwareRendererSelectionFromStore(
  selectedId: number | null,
  selectedIds: ReadonlySet<number> | undefined,
): { selectedId: number | null; selectedIds: Set<number> } {
  const state = useViewerStore.getState();
  return chartAwareRendererSelection(selectedId, selectedIds, state.chartColorIn3D, state.chartSlice);
}
