/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host an ECharts instance in a React element — the whole React adapter,
 * so the viewer owns theme injection and event wiring instead of a wrapper
 * package. ECharts is loaded lazily on first mount (the panel is a lazy
 * chunk too, so nothing of it reaches the first paint).
 *
 * The renderer seam (`ChartRenderer`) is injectable so a node:test can
 * mount the panel with a stub that records options and fires selection
 * events without a canvas.
 */
import { useEffect, useRef, useState } from 'react';
import type { EChartsOptionObject, ChartTheme } from '@ifc-lite/charts';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';

/** What a chart click / brush hands back: category indices per series. */
export interface ChartSelectEvent {
  /** Category (data) indices now selected, across series. */
  dataIndices: number[];
}

export interface ChartRendererHandle {
  setOption: (option: EChartsOptionObject) => void;
  /** Push a selection into the chart without firing `onSelect` back. */
  select: (dataIndices: readonly number[]) => void;
  resize: () => void;
  dispose: () => void;
}

export interface ChartRendererEvents {
  onSelect: (event: ChartSelectEvent) => void;
}

/** Creates a chart in `el`; the real one is ECharts, tests inject a recorder. */
export type ChartRenderer = (el: HTMLElement, events: ChartRendererEvents) => Promise<ChartRendererHandle>;

/** The real renderer: tree-shaken ECharts on canvas (`echarts-bundle.ts`, loaded on first mount). */
export const echartsRenderer: ChartRenderer = async (el, events) => {
  const { createChart } = await import('./echarts-bundle');
  const chart = createChart(el);
  let suppress = false;
  // `selectchanged` reports every selected item per series after a click;
  // `brushselected` reports the items under a drag rectangle.
  chart.on('selectchanged', (params) => {
    if (suppress) return;
    const p = params as { selected?: Array<{ dataIndex: number[] }> };
    const indices = new Set<number>();
    for (const s of p.selected ?? []) for (const i of s.dataIndex) indices.add(i);
    events.onSelect({ dataIndices: [...indices].sort((a, b) => a - b) });
  });
  chart.on('brushselected', (params) => {
    if (suppress) return;
    const p = params as { batch?: Array<{ selected?: Array<{ dataIndex: number[] }> }> };
    const indices = new Set<number>();
    for (const b of p.batch ?? []) for (const s of b.selected ?? []) for (const i of s.dataIndex) indices.add(i);
    if (indices.size > 0) events.onSelect({ dataIndices: [...indices].sort((a, b) => a - b) });
  });
  return {
    setOption: (option) => chart.setOption(option, { notMerge: true }),
    select: (dataIndices) => {
      suppress = true;
      try {
        chart.dispatchAction({ type: 'unselect', seriesIndex: 0, dataIndex: [] });
        if (dataIndices.length > 0) chart.dispatchAction({ type: 'select', dataIndex: [...dataIndices] });
      } finally {
        suppress = false;
      }
    },
    resize: () => chart.resize(),
    dispose: () => chart.dispose(),
  };
};

/** Theme tokens for ECharts, read off the stylesheet — it has no CSS variables. */
export function readChartTheme(): ChartTheme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains('dark');
  return {
    text: dark ? token('--tokyo-fg', DEFAULT_THEME.text) : DEFAULT_THEME.text,
    mutedText: dark ? token('--tokyo-fg-dark', DEFAULT_THEME.mutedText) : DEFAULT_THEME.mutedText,
    axis: dark ? token('--tokyo-dark3', DEFAULT_THEME.axis) : DEFAULT_THEME.axis,
    grid: dark ? token('--tokyo-fg-gutter', DEFAULT_THEME.grid) : DEFAULT_THEME.grid,
    background: 'transparent',
    fontFamily: style.fontFamily || DEFAULT_THEME.fontFamily,
  };
}

export interface UseEChartArgs {
  option: EChartsOptionObject | null;
  /** Category indices to show selected (from the 3D side). */
  selected: readonly number[];
  onSelect: (event: ChartSelectEvent) => void;
  renderer?: ChartRenderer;
}

/** Mount a chart in the returned ref's element and keep it in step with `option` / `selected`. */
export function useEChart({ option, selected, onSelect, renderer = echartsRenderer }: UseEChartArgs): { ref: React.RefObject<HTMLDivElement | null>; ready: boolean } {
  const ref = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ChartRendererHandle | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [ready, setReady] = useState(false);
  // Re-render on theme change so the tokens are re-read.
  const theme = useViewerStore((s) => s.theme);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    void renderer(el, { onSelect: (e) => onSelectRef.current(e) }).then((handle) => {
      if (disposed) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      setReady(true);
    });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => handleRef.current?.resize());
    observer?.observe(el);
    return () => {
      disposed = true;
      observer?.disconnect();
      handleRef.current?.dispose();
      handleRef.current = null;
      setReady(false);
    };
  }, [renderer]);

  useEffect(() => {
    if (!ready || !option) return;
    handleRef.current?.setOption(option);
    handleRef.current?.select(selected);
  }, [ready, option, theme, selected]);

  return { ref, ready };
}
