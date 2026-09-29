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
import { format } from 'echarts/core';
import { CATEGORY_LABEL_FONT_SIZE, layoutCategoryLabels } from './category-labels.js';
import { elementFieldLabel } from './element-field.js';
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

export { truncateMiddle } from './category-labels.js';

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

/** A host measurement usable as a size; anything else (unset, 0, NaN, Infinity) falls back. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

/** A screen legend label past this many characters is truncated with an ellipsis; the full name is in the tooltip. */
const LEGEND_LABEL_MAX_CHARS = 24;
const truncateLegendLabel = (name: string): string => (name.length > LEGEND_LABEL_MAX_CHARS ? `${name.slice(0, LEGEND_LABEL_MAX_CHARS - 1)}…` : name);

const PRINT_LEGEND_SYMBOL_WIDTH = 10;
const PRINT_LEGEND_SYMBOL_TEXT_GAP = 5;
const PRINT_LEGEND_ITEM_GAP = 6;

/**
 * Pack the fixed print legend using the same public ECharts text metrics as
 * the SVG renderer. The 10px font must be included in both truncation and
 * measurement: measuring a full label and rendering an ellipsis is what let
 * a single wide label miscount its row in the first place.
 */
function packPrintLegend(labels: readonly string[], width: number, font: string): {
  shownItems: number;
  rows: number;
  legendH: number;
  formatter: (name: string) => string;
} {
  const maxTextWidth = Math.max(0, width - PRINT_LEGEND_SYMBOL_WIDTH - PRINT_LEGEND_SYMBOL_TEXT_GAP - PRINT_LEGEND_ITEM_GAP);
  const formatter = (name: string) => format.truncateText(name, maxTextWidth, font, '…');
  const rowHeight = Math.max(PRINT_LEGEND_SYMBOL_WIDTH, format.getTextRect('M', font).height);
  let rows = labels.length > 0 ? 1 : 0;
  let rowWidth = 0;
  let shownItems = 0;
  for (const label of labels) {
    const text = formatter(label);
    const itemWidth = PRINT_LEGEND_SYMBOL_WIDTH + PRINT_LEGEND_SYMBOL_TEXT_GAP + format.getTextRect(text, font).width;
    const nextWidth = rowWidth === 0 ? itemWidth : rowWidth + PRINT_LEGEND_ITEM_GAP + itemWidth;
    if (nextWidth > width && rowWidth > 0) {
      rows += 1;
      rowWidth = 0;
    }
    if (rows > PRINT_LEGEND_MAX_ROWS) break;
    rowWidth = rowWidth === 0 ? itemWidth : nextWidth;
    shownItems += 1;
  }
  return {
    shownItems,
    rows,
    legendH: rows > 0 ? rows * rowHeight + (rows - 1) * PRINT_LEGEND_ITEM_GAP : 0,
    formatter,
  };
}

function measureLabel(aggregation: Aggregation): string {
  const { measure } = aggregation.spec;
  if (measure.agg === 'count') return 'Count';
  const field = aggregation.spec.measureField;
  const label = field ? elementFieldLabel(field) : measure.column ?? '';
  return `Sum of ${label}`;
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
      const printLegendFont = `10px ${theme.fontFamily}`;
      const { shownItems, legendH, formatter } = packPrintLegend(categories.map((category) => category.label), width, printLegendFont);
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
        type: 'plain', orient: 'horizontal', left: 'center', bottom: 0,
        itemWidth: PRINT_LEGEND_SYMBOL_WIDTH, itemHeight: PRINT_LEGEND_SYMBOL_WIDTH, itemGap: PRINT_LEGEND_ITEM_GAP,
        padding: 0, textStyle: { color: theme.mutedText, fontSize: 10, fontFamily: theme.fontFamily }, formatter, tooltip: { show: true },
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

  if (spec.type === 'elementCount') {
    const value = aggregation.total;
    const width = typeof args.width === 'number' && Number.isFinite(args.width) && args.width > 0 ? args.width : DEFAULT_WIDTH;
    const height = typeof args.height === 'number' && Number.isFinite(args.height) && args.height > 0 ? args.height : DEFAULT_HEIGHT;
    const fontSize = Math.max(36, Math.min(72, Math.floor(Math.min(width, height) / 6)));
    return {
      ...base,
      graphic: {
        elements: [
          {
            type: 'text',
            left: 'center',
            top: 'center',
            style: {
              text: String(value),
              font: `bold ${fontSize}px ${theme.fontFamily}`,
              fill: theme.text,
              textAlign: 'center',
              textVerticalAlign: 'middle',
            },
          },
        ],
      },
    };
  }

  // bar / stackedBar / histogram / timeline: category x, measure y
  const stacked = spec.type === 'stackedBar';
  const labels = categories.map((c) => c.label);
  // Long IFC class names ("IfcBuildingElementProxy") would collide upright and `hideOverlap`
  // would then drop a neighbour outright, so the labels are measured and tilted / shortened to
  // fit (#6480); the full name is in the tooltip. The grid reserves the room they take.
  const label = layoutCategoryLabels({
    labels,
    width: positiveOr(args.width, DEFAULT_WIDTH),
    height: positiveOr(args.height, DEFAULT_HEIGHT),
    font: `${CATEGORY_LABEL_FONT_SIZE}px ${theme.fontFamily}`,
  });
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
      // `formatter` shortens from the middle (see `truncateMiddle`); `overflow: 'truncate'` stays
      // as a backstop. `triggerEvent` + `tooltip` show the full name on hover.
      axisLabel: { color: theme.mutedText, fontSize: CATEGORY_LABEL_FONT_SIZE, interval: 0, rotate: label.rotate, width: label.width, overflow: 'truncate', hideOverlap: true, formatter: label.formatter },
      triggerEvent: true,
      // ECharts' default axis tooltip shows the already-shortened label; `value` is the category name.
      tooltip: { show: true, formatter: (params: { value?: unknown }) => format.encodeHTML(String(params.value ?? '')) },
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
