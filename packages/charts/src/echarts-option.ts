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
import type { Aggregation, Bucket } from './types.js';

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
  /** Category indices to mark selected (ECharts `select` state). */
  selected?: readonly number[];
  /** Show the title inside the chart; a host card usually draws its own. */
  showTitle?: boolean;
}

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

function selectedFlags(count: number, selected: readonly number[] | undefined): boolean[] {
  const flags = new Array<boolean>(count).fill(false);
  for (const i of selected ?? []) if (i >= 0 && i < count) flags[i] = true;
  return flags;
}

function itemData(buckets: Bucket[], flags: boolean[]): Array<Record<string, unknown>> {
  return buckets.map((b, i) => ({
    name: b.label,
    value: b.value,
    itemStyle: { color: b.color },
    selected: flags[i],
  }));
}

function barSeries(aggregation: Aggregation, flags: boolean[], stacked: boolean): Array<Record<string, unknown>> {
  return aggregation.series.map((s) => ({
    type: 'bar',
    name: s.label,
    stack: stacked ? 'total' : undefined,
    data: itemData(s.buckets, flags),
    selectedMode: 'multiple',
    select: { itemStyle: { borderColor: '#000', borderWidth: 2 } },
    emphasis: { focus: 'self' },
    itemStyle: stacked ? { color: s.buckets[0]?.color } : undefined,
    large: true,
  }));
}

export function buildEChartsOption(args: BuildOptionArgs): EChartsOptionObject {
  const { aggregation, selected } = args;
  const theme = args.theme ?? DEFAULT_THEME;
  const { spec, categories } = aggregation;
  const flags = selectedFlags(categories.length, selected);
  const unit = spec.measure.agg === 'sum' ? aggregation.unit : undefined;

  const base: EChartsOptionObject = {
    backgroundColor: theme.background,
    textStyle: { color: theme.text, fontFamily: theme.fontFamily },
    title: args.showTitle ? { text: spec.title, left: 'center', textStyle: { color: theme.text, fontSize: 13 } } : undefined,
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
        data: itemData(categories, flags),
        selectedMode: 'multiple',
        selectedOffset: 6,
        emphasis: { focus: 'self' },
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
        label: { color: '#fff' },
      }],
    };
  }

  // bar / stackedBar / histogram / timeline: category x, measure y
  const stacked = spec.type === 'stackedBar';
  return {
    ...base,
    grid: { left: 8, right: 8, top: stacked ? 32 : 12, bottom: 8, containLabel: true },
    legend: stacked ? { top: 0, textStyle: { color: theme.mutedText } } : undefined,
    xAxis: {
      type: 'category',
      data: categories.map((c) => c.label),
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.mutedText, interval: 0, rotate: categories.length > 8 ? 35 : 0, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      name: measureLabel(aggregation),
      nameTextStyle: { color: theme.mutedText },
      axisLabel: { color: theme.mutedText },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    brush: { toolbox: [], xAxisIndex: 0, brushLink: 'all', outOfBrush: { colorAlpha: 0.2 }, throttleType: 'debounce', throttleDelay: 100 },
    series: barSeries(aggregation, flags, stacked),
  };
}
