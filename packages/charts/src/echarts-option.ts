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
  /** Height available to the chart in px; print mode uses it to keep a pie's legend from overflowing a short chart. */
  height?: number;
  /**
   * SSR (PDF / preview) rendering, not the interactive canvas (#4940): the
   * pie legend's `type: 'scroll'` has nothing to scroll in a static SVG and
   * clips instead, so print mode wraps it as a fixed plain legend under a
   * shrunk pie. Screen and print both truncate long labels.
   */
  print?: boolean;
}

/** Fallback width when the host has not measured yet. */
const DEFAULT_WIDTH = 600;
/** Fallback height when the host has not measured yet. */
const DEFAULT_HEIGHT = 320;
/** Print mode caps the pie's legend to this many rows; extra categories still slice the pie, just without a name in the legend (#4940 review: an unbounded legend overflowed a short chart with many categories). */
const PRINT_LEGEND_MAX_ROWS = 4;

/** A plain-object ECharts option; typed loosely so this module needs no ECharts import. */
export type EChartsOptionObject = Record<string, unknown>;

function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

/** A legend label past this many characters is truncated with an ellipsis; the full name is in the tooltip. */
const LEGEND_LABEL_MAX_CHARS = 24;
const truncateLegendLabel = (name: string): string => (name.length > LEGEND_LABEL_MAX_CHARS ? `${name.slice(0, LEGEND_LABEL_MAX_CHARS - 1)}…` : name);

/**
 * Middle-ellipsis truncation for axis labels (#4940 review): `IfcSlab`, `IfcSpace` and
 * `IfcSpatialZone` share the "Ifc" + a capital prefix, so tail-only truncation (ECharts'
 * `overflow: 'truncate'`, and the legend's own `truncateLegendLabel`) collapses all three to
 * "IfcS…" — indistinguishable on the axis, where there is no tooltip to recover the full name.
 * Keeping a short head and a short tail instead survives the common-prefix case far more often.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 4) return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
  const keep = maxChars - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
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
    let legend: Record<string, unknown>;
    let radius: [string, string] = ['35%', '70%'];
    let center: [string, string] = ['40%', '50%'];
    // Per-slice callout labels (with leader lines) drawn over a legend that already carries every
    // name (#4940 review, headed-Chrome finding): a narrow/short pie with many categories had no
    // room for both, so the leader lines and their text landed on top of the legend grid below —
    // unreadable in both the preview and the PDF. `crowded` suppresses the callouts in that case;
    // the legend is what names the slice.
    let crowded = false;
    if (args.print) {
      // No scrollbar in a static SVG: a fixed, wrapped `plain` legend under the pie instead of a
      // clipped scroll list. A FIXED radius/center overflowed a short chart (e.g. 120pt) with many
      // categories, because nothing reserved room for however tall the wrapped legend grew — size
      // and position the pie from the room actually left after capping the legend to
      // PRINT_LEGEND_MAX_ROWS rows (categories beyond the cap still slice the pie; they just have
      // no legend entry, the same trade-off label truncation already makes for long names).
      // A non-finite or non-positive measurement (0, NaN, Infinity — a host mid-measure, or a bad
      // value round-tripped through JSON) must fall back too, not just `undefined` (review finding):
      // it would otherwise divide/multiply its way into a NaN or Infinity radius percentage.
      const width = typeof args.width === 'number' && Number.isFinite(args.width) && args.width > 0 ? args.width : DEFAULT_WIDTH;
      const height = typeof args.height === 'number' && Number.isFinite(args.height) && args.height > 0 ? args.height : DEFAULT_HEIGHT;
      const itemsPerRow = Math.max(1, Math.floor(width / 90));
      const shownItems = Math.min(categories.length, itemsPerRow * PRINT_LEGEND_MAX_ROWS);
      const legendRows = Math.min(PRINT_LEGEND_MAX_ROWS, Math.ceil(categories.length / itemsPerRow));
      const legendH = categories.length > 0 ? legendRows * 14 + 6 : 0;
      const pieAreaH = Math.max(40, height - legendH - 8);
      const pieDiameter = Math.min(width * 0.7, pieAreaH) * 0.92;
      const box = Math.min(width, height);
      const outerPct = Math.max(14, Math.min(45, (pieDiameter / 2 / (box / 2)) * 100));
      const centerYPct = Math.max(20, Math.min(48, ((pieAreaH / 2 + 8) / height) * 100));
      radius = [`${(outerPct * 0.55).toFixed(0)}%`, `${outerPct.toFixed(0)}%`];
      center = ['50%', `${centerYPct.toFixed(0)}%`];
      // The same room-left math that sizes the pie says whether a callout has anywhere to go:
      // a small pie (little radius to anchor a leader line) or more than a handful of slices
      // (leader lines fan out and cross each other, let alone the legend) is crowded.
      crowded = pieDiameter < 200 || categories.length > 8;
      legend = {
        type: 'plain', orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 10,
        textStyle: { color: theme.mutedText, fontSize: 10 }, formatter: truncateLegendLabel, tooltip: { show: true },
        // Fewer legend entries than categories: cap `data` so the wrapped legend cannot grow past its reserved rows.
        ...(shownItems < categories.length ? { data: categories.slice(0, shownItems).map((c) => c.label) } : {}),
      };
    } else {
      legend = { type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: theme.mutedText }, formatter: truncateLegendLabel, tooltip: { show: true } };
    }
    return {
      ...base,
      legend,
      series: [{
        type: 'pie',
        name: measureLabel(aggregation),
        radius,
        center,
        // An empty dataset shows the host's message, not a grey placeholder ring.
        showEmptyCircle: false,
        data: itemData(categories, flags),
        selectedMode: 'multiple',
        selectedOffset: 6,
        emphasis: { focus: 'self' },
        label: crowded ? { show: false } : { color: theme.mutedText, formatter: '{b}' },
        labelLine: crowded ? { show: false } : {},
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
  const labels = categories.map((c) => c.label);
  // Long IFC class names ("IfcBuildingElementProxy") would collide upright
  // and `hideOverlap` would then drop a neighbour outright. Each label gets
  // its share of the width and is truncated with an ellipsis instead — the
  // full name is in the tooltip and the legend. Past eight buckets the
  // shares are too narrow to read, so the labels tilt.
  const share = Math.floor((args.width ?? DEFAULT_WIDTH) / Math.max(1, categories.length)) - 6;
  const rotate = categories.length > 8 ? 30 : 0;
  // Tilted labels overlap far less, so they may run past their share.
  const labelWidth = rotate ? Math.max(60, share * 2) : Math.max(36, share);
  // A count needs no axis title; a sum says what it sums, and gets room for it.
  const yName = spec.measure.agg === 'sum' ? measureLabel(aggregation) : '';
  return {
    ...base,
    // ECharts 6 keeps axis labels inside the grid's outer bounds by default
    // (`containLabel` is the removed v5 way of saying the same).
    grid: { left: 8, right: 8, top: stacked ? 32 : yName ? 28 : 12, bottom: 8 },
    ...(stacked ? { legend: { top: 0, textStyle: { color: theme.mutedText }, formatter: truncateLegendLabel, tooltip: { show: true } } } : {}),
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: theme.axis } },
      // A character-count estimate (no DOM/canvas measure available here), same order as the
      // other size-based heuristics in this module; `overflow: 'truncate'` stays as a backstop if
      // the estimate runs long. Middle-ellipsis, not ECharts' own tail truncation (#4940 review,
      // headed-Chrome finding): `IfcSlab`/`IfcSpace`/`IfcSpatialZone` share a prefix and all
      // truncated to the same "IfcS…" on a narrow half-width chart.
      axisLabel: { color: theme.mutedText, interval: 0, rotate, width: labelWidth, overflow: 'truncate', hideOverlap: true, formatter: (name: string) => truncateMiddle(name, Math.max(4, Math.floor(labelWidth / 6.5))) },
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
