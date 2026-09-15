/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { composeLayers, type OverlayLayer } from '@/store/slices/overlaySlice';

export const CHART_OVERLAY_LAYER_ID = 'charts';

const EMPTY_SELECTION = new Set<number>();
let cachedInput: {
  selectedId: number | null;
  selectedIds: Set<number>;
  chartSlice: ReadonlySet<number>;
  paintedIds: ReadonlyMap<number, unknown>;
} | null = null;
let cachedResult: { selectedId: number | null; selectedIds: Set<number> } | null = null;
let cachedLayers: Map<string, OverlayLayer> | null = null;
let cachedAppliedColors: ReadonlyMap<number, readonly number[]> | null = null;
let cachedEffectivePaint: Map<number, unknown> | null = null;

function sameColor(a: readonly number[], b: readonly number[] | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Chart colours that survive composition and are actually retained by the scene. */
export function effectiveChartPaint(
  layers: Map<string, OverlayLayer>,
  appliedColors: ReadonlyMap<number, readonly number[]> | null,
): Map<number, unknown> | null {
  if (layers === cachedLayers && appliedColors === cachedAppliedColors) return cachedEffectivePaint;
  cachedLayers = layers;
  cachedAppliedColors = appliedColors;
  const chartPaint = layers.get(CHART_OVERLAY_LAYER_ID)?.colorOverrides;
  if (!chartPaint || chartPaint.size === 0 || !appliedColors || appliedColors.size === 0) {
    cachedEffectivePaint = null;
    return null;
  }
  const composite = composeLayers(layers).colorOverrides;
  const effective = new Map<number, unknown>();
  for (const [id, color] of chartPaint) {
    if (sameColor(color, composite.get(id)) && sameColor(color, appliedColors.get(id))) effective.set(id, color);
  }
  cachedEffectivePaint = effective;
  return effective;
}

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
  selectedIds: Set<number> | undefined,
  chartSlice: ReadonlySet<number> | null,
  paintedIds: ReadonlyMap<number, unknown> | null,
): { selectedId: number | null; selectedIds: Set<number> } {
  const selection = selectedIds ?? EMPTY_SELECTION;
  if (chartSlice === null || paintedIds === null || paintedIds.size === 0) {
    return { selectedId, selectedIds: selection };
  }
  if (
    cachedInput?.selectedId === selectedId
    && cachedInput.selectedIds === selection
    && cachedInput.chartSlice === chartSlice
    && cachedInput.paintedIds === paintedIds
  ) {
    return cachedResult!;
  }
  const visibleHighlightIds = new Set<number>();
  for (const id of selection) {
    if (!chartSlice.has(id) || !paintedIds.has(id)) visibleHighlightIds.add(id);
  }
  const result = {
    selectedId: selectedId !== null && chartSlice.has(selectedId) && paintedIds.has(selectedId) ? null : selectedId,
    selectedIds: visibleHighlightIds,
  };
  cachedInput = { selectedId, selectedIds: selection, chartSlice, paintedIds };
  cachedResult = result;
  return result;
}

/** Resolve the render-only selection against the live chart presentation. */
export function chartAwareRendererSelectionFromStore(
  selectedId: number | null,
  selectedIds: Set<number> | undefined,
  appliedColors: ReadonlyMap<number, readonly number[]> | null,
): { selectedId: number | null; selectedIds: Set<number> } {
  const state = useViewerStore.getState();
  const chartPaint = effectiveChartPaint(state.overlayLayers, appliedColors);
  return chartAwareRendererSelection(selectedId, selectedIds, state.chartSlice, chartPaint);
}
