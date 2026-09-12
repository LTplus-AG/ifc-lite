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
import type { ChartItem, EChartsOptionObject, ChartTheme } from '@ifc-lite/charts';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';

/** What a chart click hands back: the items (series + category) now selected. */
export interface ChartSelectEvent {
  items: ChartItem[];
}

export interface ChartRendererHandle {
  setOption: (option: EChartsOptionObject) => void;
  /** Push a selection into the chart without firing `onSelect` back; `partial` items get emphasis, not selection. */
  select: (full: readonly ChartItem[], partial: readonly ChartItem[]) => void;
  resize: () => void;
  dispose: () => void;
}

export interface ChartRendererEvents {
  onSelect: (event: ChartSelectEvent) => void;
}

/** Creates a chart in `el` synchronously; the real one is ECharts, tests inject a recorder. */
export type ChartFactory = (el: HTMLElement, events: ChartRendererEvents) => ChartRendererHandle;

/**
 * Loads the chart engine (once) and hands back the factory. Two phases on
 * purpose: the load is the only async step, so a mount that is undone while
 * the engine is still loading — StrictMode's double effect, a panel closed
 * at once — never creates a chart at all. (ECharts returns the *existing*
 * instance for a second `init` on the same element; creating inside the
 * async step let one mount dispose the instance the other went on to use,
 * and the card stayed blank.)
 */
export type ChartRenderer = () => Promise<ChartFactory>;

/** The real renderer: tree-shaken ECharts on canvas (`echarts-bundle.ts`, loaded on first mount). */
export const echartsRenderer: ChartRenderer = async () => {
  const { createChart } = await import('./echarts-bundle');
  return (el, events) => {
    const chart = createChart(el);
    let suppress = false;
    // `selectchanged` reports every selected item per series after a click.
    chart.on('selectchanged', (params) => {
      if (suppress) return;
      const items: ChartItem[] = [];
      for (const s of (params as { selected?: Array<{ seriesIndex: number; dataIndex: number[] }> }).selected ?? []) {
        for (const dataIndex of s.dataIndex) items.push({ seriesIndex: s.seriesIndex, dataIndex });
      }
      events.onSelect({ items });
    });
    return {
      setOption: (option) => chart.setOption(option, { notMerge: true }),
      select: (full, partial) => {
        suppress = true;
        try {
          // The option already carries `selected` per item; `downplay` + `highlight`
          // is the emphasis pass for partially selected buckets.
          chart.dispatchAction({ type: 'downplay' });
          for (const item of partial) chart.dispatchAction({ type: 'highlight', seriesIndex: item.seriesIndex, dataIndex: item.dataIndex });
          void full;
        } finally {
          suppress = false;
        }
      },
      resize: () => chart.resize(),
      dispose: () => chart.dispose(),
    };
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
  /** Items fully selected in 3D (marked selected in the option) and partially selected (emphasised). */
  selected: readonly ChartItem[];
  partial: readonly ChartItem[];
  onSelect: (event: ChartSelectEvent) => void;
  renderer?: ChartRenderer;
}

/** Mount a chart in the returned ref's element and keep it in step with `option` / `selected`. */
export function useEChart({ option, selected, partial, onSelect, renderer = echartsRenderer }: UseEChartArgs): { ref: React.RefObject<HTMLDivElement | null>; ready: boolean } {
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
    void renderer().then((create) => {
      if (disposed) return;
      handleRef.current = create(el, { onSelect: (e) => onSelectRef.current(e) });
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
    handleRef.current?.select(selected, partial);
  }, [ready, option, theme, selected, partial]);

  return { ref, ready };
}
