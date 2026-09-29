/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Category-axis label layout (#6480). The one place that decides how the x
 * labels of a bar / histogram / timeline chart are drawn, so the on-screen
 * canvas chart and the off-screen SVG behind the report and the document page
 * cannot drift apart.
 *
 * Labels are measured with ECharts' own text metrics (the same ones the SVG
 * renderer lays out with), not estimated from a character count. The layout
 * picks the smallest tilt at which neighbours no longer touch, then gives each
 * label as much length as a bounded slice of the chart height allows (the grid
 * grows its bottom margin to fit the tilted labels), and only then truncates
 * from the middle. The full name stays available in the tooltip.
 */
import { format } from 'echarts/core';

/** ECharts' default axis-label size; the layout measures at this size. */
export const CATEGORY_LABEL_FONT_SIZE = 12;
/** Tilt used for a crowded axis (more buckets than this) even when the labels are short, as before #6480. */
const CROWDED_CATEGORY_COUNT = 8;
/** Width the plot loses to the grid margins and the value axis' tick labels; the categories share the rest. */
const PLOT_INSET = 56;
/** Px shaved off the fit so ECharts' own `overflow: truncate` backstop never re-truncates a label the formatter already fitted. */
const FIT_SLACK = 4;
/** Gap kept between the width share of one label and its neighbour. */
const LABEL_GAP = 6;
/** Tilts tried in order; the first that keeps neighbours apart wins, the last is the fallback. */
const TILTS = [0, 30, 45, 90] as const;
/** Share of the chart height the tilted labels may take, and its floor / ceiling in px. */
const LABEL_HEIGHT_SHARE = 0.3;
const LABEL_HEIGHT_MIN = 48;
const LABEL_HEIGHT_MAX = 120;

export interface CategoryLabelLayout {
  /** Label tilt in degrees. */
  rotate: number;
  /** Longest a label may be drawn, in px along its baseline. */
  width: number;
  /** Shortens a label that is wider than `width`; returns short labels unchanged. */
  formatter: (name: string) => string;
}

/**
 * Middle-ellipsis truncation for axis labels (#4940 review): `IfcSlab`, `IfcSpace` and
 * `IfcSpatialZone` share the "Ifc" + a capital prefix, so tail-only truncation (ECharts'
 * `overflow: 'truncate'`, and the legend's own `truncateLegendLabel`) collapses all three to
 * "IfcS…" — indistinguishable on the axis. Keeping a short head and a short tail instead
 * survives the common-prefix case far more often.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  if (maxChars < 4) return `${text.slice(0, maxChars - 1)}…`;
  const keep = maxChars - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The longest middle-truncation of `text` that measures no wider than `maxPx`. */
function fitMiddle(text: string, maxPx: number, font: string): string {
  if (format.getTextRect(text, font).width <= maxPx) return text;
  let lo = 1;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (format.getTextRect(truncateMiddle(text, mid), font).width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return truncateMiddle(text, lo);
}


export function layoutCategoryLabels({ labels, width, height, font }: { labels: readonly string[]; width: number; height: number; font: string }): CategoryLabelLayout {
  const count = Math.max(1, labels.length);
  const spacing = Math.max(1, (width - PLOT_INSET) / count);
  const share = Math.floor(spacing) - LABEL_GAP;
  const lineHeight = format.getTextRect('M', font).height;
  const widest = labels.reduce((max, label) => Math.max(max, format.getTextRect(label, font).width), 0);
  const budget = Math.min(LABEL_HEIGHT_MAX, Math.max(LABEL_HEIGHT_MIN, height * LABEL_HEIGHT_SHARE));

  // Upright only when every label fits its share whole; otherwise the smallest tilt at which
  // parallel neighbours clear each other: labels `spacing` apart along the axis are
  // `spacing * sin` apart perpendicular to their baseline, which must exceed a line's height
  // (else `hideOverlap` drops categories). The steepest tilt is the fallback.
  const candidates = count > CROWDED_CATEGORY_COUNT ? TILTS.filter((t) => t > 0) : TILTS;
  const rotate = candidates.find((tilt) => (tilt === 0 ? widest <= share : lineHeight / Math.sin((tilt * Math.PI) / 180) <= spacing)) ?? 90;
  const radians = (rotate * Math.PI) / 180;
  const room = rotate === 0 ? share : (budget - lineHeight * Math.cos(radians)) / Math.sin(radians);
  const labelWidth = Math.max(36, Math.floor(room));
  return { rotate, width: labelWidth, formatter: (name) => fitMiddle(name, labelWidth - FIT_SLACK, font) };
}
