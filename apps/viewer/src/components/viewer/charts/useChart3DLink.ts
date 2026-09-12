/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two halves of chart ↔ 3D (#3944).
 *
 * Chart → 3D: a bucket click selects its elements on BOTH selection channels
 * (the renderer highlight set and the model-aware refs — the lists table's
 * `selectExact` contract, `apps/viewer/AGENTS.md`), then presents them by the
 * panel's focus mode: `ghost` translucents everything else, `isolate` hides
 * it, `highlight` only outlines. Ghost / isolate are the shared channels, so
 * the panel records a value-matched ownership claim (`chartVisibilityOwned`)
 * and releases only what it installed, like clash and the basket. Ids go
 * through `resolvePresentationIds` so a geometry-less assembly in a bucket
 * still lights up its parts.
 *
 * 3D → chart: the renderer highlight set (`selectedEntityIds`) is the channel
 * every 3D pick writes, so that is what the panel reads back; a write this
 * hook made itself is recognised by value and not echoed into a second pass.
 *
 * Colour in 3D: the active chart's buckets become an overlay layer between
 * the lens (50) and a running 4D playback (100), so a chart is a deliberate,
 * temporary colouring that an animation still wins over.
 */
import { useCallback, useEffect, useRef } from 'react';
import { categoriesForIds, idsForCategories, type Aggregation } from '@ifc-lite/charts';
import { hexToRgba } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import type { ChartFocusMode } from '@/store/slices/chartSlice';
import type { RGBA } from '@/store/slices/overlaySlice';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { releaseOwnedVisibility } from '@/lib/visibility/ownership';

export const CHART_OVERLAY_LAYER_ID = 'charts';
/** Between the lens (50) and the 4D animation (100). */
export const CHART_OVERLAY_PRIORITY = 75;

export interface ChartSelection {
  /** Category indices whose every element is selected in 3D. */
  full: number[];
  /** Category indices with some, not all, elements selected. */
  partial: number[];
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Release the panel's claim on the isolate / ghost channel, if it still holds it. */
export function releaseChartVisibility(): void {
  const state = useViewerStore.getState();
  releaseOwnedVisibility(state, state.chartVisibilityOwned);
  state.setChartVisibilityOwned(null);
}

/** Present `ids` by `mode`, claiming the channel written. Exported for the test. */
export function presentChartIds(ids: number[], mode: ChartFocusMode): void {
  const state = useViewerStore.getState();
  const presented = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, ids);
  // Release first: switching ghost → isolate must not leave a stale ghost claim.
  releaseOwnedVisibility(state, state.chartVisibilityOwned);
  if (mode === 'ghost') {
    state.setGhostExceptEntities(new Set(presented));
    const installed = useViewerStore.getState().ghostExceptEntities;
    state.setChartVisibilityOwned(installed ? { channel: 'ghost', ids: installed } : null);
  } else if (mode === 'isolate') {
    state.setIsolatedEntities(new Set(presented));
    const installed = useViewerStore.getState().isolatedEntities;
    state.setChartVisibilityOwned(installed ? { channel: 'isolate', ids: installed } : null);
  } else {
    state.setChartVisibilityOwned(null);
  }
}

/** Replace the 3D selection with `ids` on both channels. Exported for the test. */
export function selectChartIds(ids: number[]): void {
  const state = useViewerStore.getState();
  state.clearEntitySelection();
  if (ids.length === 0) return;
  state.setSelectedEntityIds(ids);
  const refs = [];
  for (const id of ids) {
    const ref = state.resolveGlobalIdFromModels(id);
    if (ref) refs.push(ref);
  }
  if (refs.length > 0) state.addEntitiesToSelection(refs);
}

export interface Chart3DLink {
  /** A chart click: select the buckets' elements, present them, and set the dashboard slice. */
  selectCategories: (aggregation: Aggregation, indices: readonly number[]) => void;
  /** Clear the chart selection, the slice, and release any presentation the panel installed. */
  clearSelection: () => void;
  /** Frame the buckets' elements in the camera. */
  frameCategories: (aggregation: Aggregation, indices: readonly number[]) => void;
  /** What the current 3D selection means for this aggregation. */
  selectionFor: (aggregation: Aggregation) => ChartSelection;
}

export function useChart3DLink(): Chart3DLink {
  const focusMode = useViewerStore((s) => s.chartFocusMode);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  // The selection this hook last wrote; a matching store value is our own echo.
  const lastWrittenRef = useRef<Set<number> | null>(null);

  const selectCategories = useCallback((aggregation: Aggregation, indices: readonly number[]) => {
    const ids = [...idsForCategories(aggregation, indices)];
    lastWrittenRef.current = new Set(ids);
    selectChartIds(ids);
    presentChartIds(ids, focusMode);
    useViewerStore.getState().setChartSlice(ids.length > 0 ? new Set(ids) : null, aggregation.spec.id);
  }, [focusMode]);

  const clearSelection = useCallback(() => {
    lastWrittenRef.current = null;
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setChartSlice(null);
    releaseChartVisibility();
  }, []);

  const frameCategories = useCallback((aggregation: Aggregation, indices: readonly number[]) => {
    const state = useViewerStore.getState();
    const ids = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, [...idsForCategories(aggregation, indices)]);
    if (ids.length > 0) state.cameraCallbacks?.frameEntities?.(ids);
  }, []);

  const selectionFor = useCallback((aggregation: Aggregation): ChartSelection => {
    return categoriesForIds(aggregation, selectedEntityIds);
  }, [selectedEntityIds]);

  // A 3D pick that is NOT our own write drops the slice: the dashboard then
  // shows the whole scope again while the charts highlight what was picked.
  useEffect(() => {
    const written = lastWrittenRef.current;
    if (written && sameSet(written, selectedEntityIds)) return;
    if (written) {
      lastWrittenRef.current = null;
      useViewerStore.getState().setChartSlice(null);
    }
  }, [selectedEntityIds]);

  // When the focus mode changes while a chart selection is on screen, re-present it.
  useEffect(() => {
    const written = lastWrittenRef.current;
    if (written && written.size > 0) presentChartIds([...written], focusMode);
  }, [focusMode]);

  // Release the presentation when the panel goes away.
  useEffect(() => () => releaseChartVisibility(), []);

  return { selectCategories, clearSelection, frameCategories, selectionFor };
}

/**
 * Keep the `charts` overlay layer in step with the active chart's buckets while
 * "colour in 3D" is on; remove it when it is off or the aggregation is gone.
 */
export function useChartColorOverlay(aggregation: Aggregation | null): void {
  const enabled = useViewerStore((s) => s.chartColorIn3D);
  useEffect(() => {
    const state = useViewerStore.getState();
    if (!enabled || !aggregation) {
      state.removeOverlayLayer(CHART_OVERLAY_LAYER_ID);
      return;
    }
    const colorOverrides = new Map<number, RGBA>();
    for (const bucket of aggregation.categories) {
      const rgba = hexToRgba(bucket.color, 1);
      for (let i = 0; i < bucket.ids.length; i++) colorOverrides.set(bucket.ids[i], rgba);
    }
    state.registerOverlayLayer({ id: CHART_OVERLAY_LAYER_ID, priority: CHART_OVERLAY_PRIORITY, hiddenIds: null, colorOverrides });
    return () => useViewerStore.getState().removeOverlayLayer(CHART_OVERLAY_LAYER_ID);
  }, [enabled, aggregation]);
}
