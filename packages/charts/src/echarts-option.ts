/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An aggregation as an ECharts option.
 *
 * The option touches no DOM and holds no host state, so the same builder
 * serves the on-screen canvas chart, the off-screen SVG export and a test
 * that inspects the shape. Every series gets `selectedMode: 'multiple'` and an
 * `emphasis.focus` blur so a click is a persistent selection the host can
 * read back through `selectchanged`, and everything not selected fades the
 * way the 3D view ghosts it.
 *
 * Colours come from the buckets (assigned by label in `aggregate`), never
 * from ECharts' own palette, so the legend, the 3D overlay and the printed
 * report agree.
 */
import type { Aggregation, Bucket, ChartItem } from './types.js';

/** The tokens a host reads off its stylesheet; ECharts has no CSS variables. */
export interface ChartTheme {
  text: string;
  mutedText: string;
  axis: string;
  grid: string;
  background: string;
  fontFamily: string;
}

export const DEFAULT_THEME: ChartTheme = {
  text: '#1f2933',
  mutedText: '#6b7280',
  axis: '#9ca3af',
  grid: '#e5e7eb',
  background: 'transparent',
  fontFamily: 'system-ui, sans-serif',
};

export interface BuildOptionArgs {
  aggregation: Aggregation;
  theme?: ChartTheme;
  /** Items to mark selected (ECharts `select` state); a number is a category index on every series. */
  selected?: ReadonlyArray<number | ChartItem>;
  /** Show the title inside the chart; a host card usually draws its own. */
  showTitle?: boolean;
  /** Width available to the chart in px; sizes the category labels so none is dropped. */
  width?: number;
}

/** Fallback width when the host has not measured yet. */
const DEFAULT_WIDTH = 600;

/** A plain-object ECharts option; typed loosely so this module needs no ECharts import. */
export type EChartsOptionObject = Record<string, unknown>;

function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

function measureLabel(aggregation: Aggregation): string {
  const { measure } = aggregation.spec;
  return measure.agg === 'count' ? 'Count' : `Sum of ${measure.column ?? ''}`;
}

/** Selected flags for one series: category indices apply to every series, items only to their own. */
function selectedFlags(count: number, seriesIndex: number, selected: ReadonlyArray<number | ChartItem> | undefined): boolean[] {
  const flags = new Array<boolean>(count).fill(false);
  for (const sel of selected ?? []) {
    const i = typeof sel === 'number' ? sel : sel.seriesIndex === seriesIndex ? sel.dataIndex : -1;
    if (i >= 0 && i < count) flags[i] = true;
  }
  return flags;
}

/** Opacity of the buckets outside a selection, so the selected ones read at a glance. */
export const UNSELECTED_OPACITY = 0.35;

function itemData(buckets: Bucket[], flags: boolean[]): Array<Record<string, unknown>> {
  const dimOthers = flags.some(Boolean);
  return buckets.map((b, i) => ({
    name: b.label,
    value: b.value,
    itemStyle: dimOthers && !flags[i] ? { color: b.color, opacity: UNSELECTED_OPACITY } : { color: b.color },
    selected: flags[i],
  }));
}

function barSeries(aggregation: Aggregation, selected: BuildOptionArgs['selected'], stacked: boolean): Array<Record<string, unknown>> {
  return aggregation.series.map((s, seriesIndex) => ({
    type: 'bar',
    name: s.label,
    stack: stacked ? 'total' : undefined,
    data: itemData(s.buckets, selectedFlags(s.buckets.length, seriesIndex, selected)),
    selectedMode: 'multiple',
    select: { itemStyle: { borderColor: '#000', borderWidth: 2 } },
    emphasis: { focus: 'self' },
    // Hover blur on the others stays readable (ECharts' default is 0.1).
    blur: { itemStyle: { opacity: 0.3 } },
    itemStyle: stacked ? { color: s.buckets[0]?.color } : undefined,
    large: true,
  }));
}

export function buildEChartsOption(args: BuildOptionArgs): EChartsOptionObject {
  const { aggregation, selected } = args;
  const theme = args.theme ?? DEFAULT_THEME;
  const { spec, categories } = aggregation;
  const flags = selectedFlags(categories.length, 0, selected);
  const unit = spec.measure.agg === 'sum' ? aggregation.unit : undefined;

  const base: EChartsOptionObject = {
    backgroundColor: theme.background,
    textStyle: { color: theme.text, fontFamily: theme.fontFamily },
    // Only components that are actually used may appear as keys: ECharts
    // reports an `undefined` `title` as a missing TitleComponent.
    ...(args.showTitle ? { title: { text: spec.title, left: 'center', textStyle: { color: theme.text, fontSize: 13 } } } : {}),
    tooltip: { trigger: 'item', valueFormatter: (v: number) => formatValue(v, unit) },
    animation: false,
  };

  if (spec.type === 'pie') {
    return {
      ...base,
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: theme.mutedText } },
      series: [{
        type: 'pie',
        name: measureLabel(aggregation),
        radius: ['35%', '70%'],
        center: ['40%', '50%'],
        // An empty dataset shows the host's message, not a grey placeholder ring.
        showEmptyCircle: false,
        data: itemData(categories, flags),
        selectedMode: 'multiple',
        selectedOffset: 6,
        emphasis: { focus: 'self' },
        blur: { itemStyle: { opacity: 0.3 } },
        label: { color: theme.mutedText, formatter: '{b}' },
      }],
    };
  }

  if (spec.type === 'treemap') {
    return {
      ...base,
      series: [{
        type: 'treemap',
        name: measureLabel(aggregation),
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        data: itemData(categories, flags),
        selectedMode: 'multiple',
        emphasis: { focus: 'self' },
        blur: { itemStyle: { opacity: 0.3 } },
        label: { color: '#fff' },
      }],
    };
  }

  // bar / stackedBar / histogram / timeline: category x, measure y
  const stacked = spec.type === 'stackedBar';
  const labels = categories.map((c) => c.label);
  // Long IFC class names ("IfcBuildingElementProxy") would collide upright
  // and `hideOverlap` would then drop a neighbour outright. Each label gets
  // its share of the width and is truncated with an ellipsis instead — the
  // full name is in the tooltip and the legend. Past eight buckets the
  // shares are too narrow to read, so the labels tilt.
  const labelWidth = Math.max(36, Math.floor((args.width ?? DEFAULT_WIDTH) / Math.max(1, categories.length)) - 6);
  const rotate = categories.length > 8 ? 30 : 0;
  // A count needs no axis title; a sum says what it sums, and gets room for it.
  const yName = spec.measure.agg === 'sum' ? measureLabel(aggregation) : '';
  return {
    ...base,
    // ECharts 6 keeps axis labels inside the grid's outer bounds by default
    // (`containLabel` is the removed v5 way of saying the same).
    grid: { left: 8, right: 8, top: stacked ? 32 : yName ? 28 : 12, bottom: 8 },
    ...(stacked ? { legend: { top: 0, textStyle: { color: theme.mutedText } } } : {}),
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.mutedText, interval: 0, rotate, width: labelWidth, overflow: 'truncate', hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      name: yName,
      nameTextStyle: { color: theme.mutedText },
      axisLabel: { color: theme.mutedText },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: barSeries(aggregation, selected, stacked),
  };
}
