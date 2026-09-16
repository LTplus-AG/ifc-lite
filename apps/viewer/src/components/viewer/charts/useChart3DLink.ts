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
 * the panel records an identity-matched ownership claim (`chartVisibilityOwned`)
 * and releases only what it installed, like clash and the basket. Ids go
 * through `resolvePresentationIds` so a geometry-less assembly in a bucket
 * still lights up its parts.
 *
 * 3D → chart: the renderer highlight set (`selectedEntityIds`) is the channel
 * every 3D pick writes, so that is what the panel reads back. A store-level
 * revision records chart ownership across both selection channels and mounts.
 *
 * Colour in 3D: the active chart's buckets become an overlay layer between
 * the lens (50) and a running 4D playback (100), so a chart is a deliberate,
 * temporary colouring that an animation still wins over.
 */
import { useCallback, useEffect } from 'react';
import { idsForItems, itemsForIds, type Aggregation, type ChartItem } from '@ifc-lite/charts';
import { hexToRgba } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import type { ChartBucketIdentity, ChartFocusMode } from '@/store/slices/chartSlice';
import type { RGBA } from '@/store/slices/overlaySlice';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { releaseOwnedVisibility } from '@/lib/visibility/ownership';
import { CHART_OVERLAY_LAYER_ID } from '@/lib/charts/renderer-selection';

/** Between the lens (50) and the 4D animation (100). */
export const CHART_OVERLAY_PRIORITY = 75;

export interface ChartSelection {
  /** Items whose every element is selected in 3D. */
  full: ChartItem[];
  /** Items with some, not all, elements selected. */
  partial: ChartItem[];
}

function isSyntheticOther(bucket: { key: string }): boolean {
  return 'isOther' in bucket && bucket.isOther === true;
}

/** Stable identity for a rendered chart item across filtering and re-ordering. */
export function chartBucketIdentity(
  aggregation: Aggregation,
  item: ChartItem,
): ChartBucketIdentity | null {
  const series = aggregation.series[item.seriesIndex];
  const bucket = series?.buckets[item.dataIndex];
  return series && bucket
    ? { seriesKey: series.key, bucketKey: bucket.key, isOther: isSyntheticOther(bucket), color: bucket.color, ids: [...bucket.ids] }
    : null;
}

export function sameChartBucketIdentity(a: ChartBucketIdentity, b: ChartBucketIdentity): boolean {
  return a.seriesKey === b.seriesKey && a.bucketKey === b.bucketKey && a.isOther === b.isOther;
}

function aggregationIds(aggregation: Aggregation): Set<number> {
  const ids = new Set<number>();
  for (const series of aggregation.series) for (const bucket of series.buckets) {
    for (const id of bucket.ids) ids.add(id);
  }
  return ids;
}

/** Whether every selected ID still belongs to the source chart's live data. */
export function chartSelectionIsLive(
  aggregation: Aggregation,
  selectedBuckets: readonly ChartBucketIdentity[],
  selectedIds: ReadonlySet<number>,
): boolean {
  const liveIds = aggregationIds(aggregation);
  for (const id of selectedIds) if (!liveIds.has(id)) return false;
  for (const selected of selectedBuckets) {
    const series = aggregation.series.find((candidate) => candidate.key === selected.seriesKey);
    const bucket = series?.buckets.find((candidate) => candidate.key === selected.bucketKey && Boolean(candidate.isOther) === selected.isOther);
    if (!bucket) {
      const folded = series?.buckets.find((candidate) => candidate.isOther);
      const foldedIds = new Set(folded?.ids ?? []);
      if (!folded || selected.ids.some((id) => !foldedIds.has(id))) return false;
    }
  }
  return true;
}

/** Release the panel's claim on the isolate / ghost channel, if it still holds it. */
export function releaseChartVisibility(): void {
  const state = useViewerStore.getState();
  const released = releaseOwnedVisibility(state, state.chartVisibilityOwned);
  const current = useViewerStore.getState();
  useViewerStore.setState({
    chartVisibilityOwned: null,
    ...(released ? { chartVisibilityRevision: current.visibilityRevision } : {}),
  });
}

/** Present `ids` by `mode`, claiming the channel written. Exported for the test. */
export function presentChartIds(ids: number[], mode: ChartFocusMode): void {
  const state = useViewerStore.getState();
  const presented = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, ids);
  // Release first: switching ghost → isolate must not leave a stale ghost claim.
  releaseOwnedVisibility(state, state.chartVisibilityOwned);
  const current = useViewerStore.getState();
  if (mode === 'ghost') {
    const installed = new Set(presented);
    const visibilityRevision = current.visibilityRevision + 1;
    useViewerStore.setState({
      ghostExceptEntities: installed,
      isolatedEntities: null,
      idsFocusVisibilityOwned: null,
      clashVisibilityOwned: null,
      basketVisibilityOwned: null,
      chartVisibilityOwned: { channel: 'ghost', ids: installed },
      chartVisibilityRevision: visibilityRevision,
    });
  } else if (mode === 'isolate') {
    const installed = new Set(presented);
    const visibilityRevision = current.visibilityRevision + 1;
    useViewerStore.setState({
      isolatedEntities: installed,
      ghostExceptEntities: null,
      hiddenEntities: new Set(),
      idsFocusVisibilityOwned: null,
      clashVisibilityOwned: null,
      basketVisibilityOwned: null,
      chartVisibilityOwned: { channel: 'isolate', ids: installed },
      chartVisibilityRevision: visibilityRevision,
    });
  } else {
    useViewerStore.setState({
      chartVisibilityOwned: null,
      chartVisibilityRevision: useViewerStore.getState().visibilityRevision,
    });
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
  /** A chart click: select the items' elements, present them, and set the dashboard slice. */
  selectItems: (aggregation: Aggregation, items: readonly ChartItem[]) => void;
  /** Clear the chart selection, the slice, and release any presentation the panel installed. */
  clearSelection: () => void;
  /** Drop stale chart ownership, clearing entity selection only if it is still the chart's exact write. */
  clearSelectionIfOwned: (sourceId: string, slice: Set<number>, buckets: readonly ChartBucketIdentity[]) => void;
  /** Frame the items' elements in the camera. */
  frameItems: (aggregation: Aggregation, items: readonly ChartItem[]) => void;
  /** What the current 3D selection means for this aggregation. */
  selectionFor: (aggregation: Aggregation) => ChartSelection;
}

export function useChart3DLink(): Chart3DLink {
  const focusMode = useViewerStore((s) => s.chartFocusMode);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const selectionRevision = useViewerStore((s) => s.selectionRevision);
  const chartSelectionRevision = useViewerStore((s) => s.chartSelectionRevision);
  const chartSlice = useViewerStore((s) => s.chartSlice);

  const selectItems = useCallback((aggregation: Aggregation, items: readonly ChartItem[]) => {
    const ids = [...idsForItems(aggregation, items)];
    const buckets = items.flatMap((item): ChartBucketIdentity[] => {
      const identity = chartBucketIdentity(aggregation, item);
      return identity ? [identity] : [];
    });
    selectChartIds(ids);
    presentChartIds(ids, focusMode);
    const state = useViewerStore.getState();
    state.setChartSlice(ids.length > 0 ? new Set(ids) : null, aggregation.spec.id, buckets, state.selectionRevision);
  }, [focusMode]);

  const clearSelection = useCallback(() => {
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setChartSlice(null);
    releaseChartVisibility();
  }, []);

  const clearSelectionIfOwned = useCallback((sourceId: string, slice: Set<number>, buckets: readonly ChartBucketIdentity[]) => {
    const state = useViewerStore.getState();
    // A newer chart click owns different object identities. An ordinary 3D
    // pick may have replaced selectedEntityIds before the hook that drops the
    // slice has run. In either case, never erase the newer selection.
    if (state.chartSliceSource !== sourceId || state.chartSlice !== slice || state.chartSliceBuckets !== buckets) return;
    if (state.chartSelectionRevision === state.selectionRevision) state.clearEntitySelection();
    state.setChartSlice(null);
    releaseChartVisibility();
  }, []);

  const frameItems = useCallback((aggregation: Aggregation, items: readonly ChartItem[]) => {
    const state = useViewerStore.getState();
    const ids = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, [...idsForItems(aggregation, items)]);
    if (ids.length > 0) state.cameraCallbacks?.frameEntities?.(ids);
  }, []);

  const selectionFor = useCallback((aggregation: Aggregation): ChartSelection => {
    return itemsForIds(aggregation, selectedEntityIds);
  }, [selectedEntityIds]);

  // A 3D pick that is NOT our own complete selection write drops the slice.
  // Store-level revisions survive closing/reopening Charts and cover primary-
  // only writes (for example IDS focus), unlike Set identity or a hook ref.
  useEffect(() => {
    if (chartSlice && chartSelectionRevision !== selectionRevision) {
      releaseChartVisibility();
      useViewerStore.getState().setChartSlice(null);
    }
  }, [chartSlice, chartSelectionRevision, selectionRevision]);

  // When the focus mode changes while a chart selection is on screen, re-present it.
  useEffect(() => {
    if (
      !chartSlice
      || chartSelectionRevision !== selectionRevision
      || chartSlice.size === 0
    ) return;
    const current = useViewerStore.getState();
    if (
      current.chartSlice !== chartSlice
      || current.chartSelectionRevision !== chartSelectionRevision
      || current.selectionRevision !== selectionRevision
      // A content-preserving owner may replay the same channel (Space Sketch
      // captures/restores it), advancing visibilityRevision while the chart's
      // verified ownership record deliberately survives. That is still safe
      // to re-present on a focus-mode change. With no live claim, the revision
      // match remains the remount guard against overwriting a newer
      // visibility-only action performed while Charts was closed.
      || (current.chartVisibilityOwned === null
        && current.chartVisibilityRevision !== current.visibilityRevision)
    ) return;
    presentChartIds([...chartSlice], current.chartFocusMode);
  }, [chartSlice, chartSelectionRevision, focusMode, selectionRevision]);

  // Release the presentation when the panel goes away.
  useEffect(() => () => releaseChartVisibility(), []);

  return { selectItems, clearSelection, clearSelectionIfOwned, frameItems, selectionFor };
}

/**
 * Keep the `charts` overlay layer in step with the active chart's buckets while
 * "colour in 3D" is on; remove it when it is off or the aggregation is gone.
 */
export function chartColorOverrides(
  aggregation: Aggregation,
  selectedIds: ReadonlySet<number> | null,
  focusMode: ChartFocusMode,
  selectedBuckets: readonly ChartBucketIdentity[] | null,
): Map<number, RGBA> {
  const ghostSelection = focusMode === 'ghost' && selectedIds !== null;
  const liveIds = aggregationIds(aggregation);
  const colorOverrides = new Map<number, RGBA>();
  for (const series of aggregation.series) for (const bucket of series.buckets) {
    const rgba = hexToRgba(bucket.color, 1);
    for (let i = 0; i < bucket.ids.length; i++) {
      const id = bucket.ids[i];
      // In ghost mode the surrounding model must keep its authored colour.
      // A renderer colour override is also an opaque-pipeline promotion, so
      // painting context buckets here would make them bright and solid rather
      // than translucent (#4832).
      if (!ghostSelection || selectedIds.has(id)) colorOverrides.set(id, rgba);
    }
  }
  // Bucket membership is allowed to overlap (for example, clash rules). IDs
  // therefore cannot identify which bucket was clicked. Reapply the exact
  // selected marks last so their colour wins every overlap (#4832).
  for (const selected of selectedBuckets ?? []) {
    const rgba = hexToRgba(selected.color, 1);
    for (const id of selected.ids) {
      // Saved IDs survive named <-> Other folding, but vanished data must not
      // retain renderer ownership or suppress ordinary selection highlighting.
      if (!liveIds.has(id)) continue;
      if (!ghostSelection || selectedIds.has(id)) colorOverrides.set(id, rgba);
    }
  }
  return colorOverrides;
}

export function useChartColorOverlay(aggregation: Aggregation | null, selectedBuckets: readonly ChartBucketIdentity[] | null): void {
  const enabled = useViewerStore((s) => s.chartColorIn3D);
  const modelCount = useViewerStore((s) => s.models.size);
  const selectedIds = useViewerStore((s) => s.chartSlice);
  const focusMode = useViewerStore((s) => s.chartFocusMode);
  useEffect(() => {
    const state = useViewerStore.getState();
    if (!enabled || !aggregation || modelCount === 0) {
      state.removeOverlayLayer(CHART_OVERLAY_LAYER_ID);
      return;
    }
    const colorOverrides = chartColorOverrides(aggregation, selectedIds, focusMode, selectedBuckets);
    state.registerOverlayLayer({ id: CHART_OVERLAY_LAYER_ID, priority: CHART_OVERLAY_PRIORITY, hiddenIds: null, colorOverrides });
    return () => useViewerStore.getState().removeOverlayLayer(CHART_OVERLAY_LAYER_ID);
  }, [enabled, aggregation, modelCount, selectedIds, focusMode, selectedBuckets]);
}
