/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coordination report's page model (#3944): a report is a dashboard
 * printed. This module lays the blocks out — title block, one block per
 * chart (vector chart, optional 3D snapshot, bucket table) — into pages of
 * the chosen size and orientation, page breaks included, and returns a
 * pure description. Nothing here touches jsPDF, so the layout is testable
 * on its own and the renderer (`generate-report-pdf.ts`) only draws what it
 * is told.
 *
 * Units are PDF points (1/72 in). A4 = 595 × 842, A3 = 842 × 1191.
 */
import type { Aggregation, ReportPageSetup } from '@ifc-lite/charts';

export const PAGE_SIZES_PT: Record<ReportPageSetup['size'], { w: number; h: number }> = {
  A4: { w: 595.28, h: 841.89 },
  A3: { w: 841.89, h: 1190.55 },
};

export const REPORT_MARGIN = 40;
const TITLE_HEIGHT = 48;
const HEADER_HEIGHT = 30;
const FOOTER_HEIGHT = 24;
const CHART_HEIGHT = 240;
const SNAPSHOT_HEIGHT = 200;
const TABLE_ROW_HEIGHT = 12;
const TABLE_HEAD_HEIGHT = 14;
const BLOCK_GAP = 14;
/** Table rows per chart block; beyond this the table says how many more. */
export const TABLE_MAX_ROWS = 25;

export interface ReportChartBlock {
  kind: 'chart';
  chartId: string;
  title: string;
  subtitle: string;
  /** Chart box, in points, on its page. */
  chart: { x: number; y: number; w: number; h: number };
  snapshot: { x: number; y: number; w: number; h: number } | null;
  /** Bucket table: [label, count, value], plus a trailing "… n more" row when truncated. */
  table: { x: number; y: number; w: number; rows: Array<[string, string, string]>; head: [string, string, string] };
}

export interface ReportTitleBlock {
  kind: 'title';
  title: string;
  /** Title-block fields in display order: `[label, value]`. */
  fields: Array<[string, string]>;
  y: number;
}

export type ReportBlock = ReportTitleBlock | ReportChartBlock;

export interface ReportPage {
  index: number;
  blocks: ReportBlock[];
}

export interface ReportLayout {
  page: ReportPageSetup;
  /** Page box in points. */
  size: { w: number; h: number };
  pages: ReportPage[];
  /** Running header/footer text. */
  header: string;
  footer: string;
}

export interface ComposeReportInput {
  name: string;
  page: ReportPageSetup;
  titleBlock: Record<string, string>;
  snapshots: boolean;
  charts: Array<{ id: string; title: string; aggregation: Aggregation | null }>;
  generatedAt: string;
}

export function pageBox(page: ReportPageSetup): { w: number; h: number } {
  const base = PAGE_SIZES_PT[page.size];
  return page.orientation === 'landscape' ? { w: base.h, h: base.w } : base;
}

function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

/** The bucket table for a chart: every bucket in display order, capped at `maxRows` ({@link TABLE_MAX_ROWS} by default). */
export function bucketTable(aggregation: Aggregation, maxRows = TABLE_MAX_ROWS): { head: [string, string, string]; rows: Array<[string, string, string]> } {
  const measure = aggregation.spec.measure.agg === 'count' ? 'Count' : `Sum of ${aggregation.spec.measure.column ?? ''}`;
  const rows: Array<[string, string, string]> = aggregation.categories.slice(0, Math.max(0, maxRows)).map((b) => [
    b.label,
    b.count.toLocaleString(),
    aggregation.spec.measure.agg === 'count' ? '' : formatValue(b.value, aggregation.unit),
  ]);
  const more = aggregation.categories.length - rows.length;
  if (more > 0) rows.push([`… ${more} more`, '', '']);
  return { head: ['Bucket', 'Elements', aggregation.spec.measure.agg === 'count' ? '' : measure], rows };
}

export function composeReport(input: ComposeReportInput): ReportLayout {
  const size = pageBox(input.page);
  const contentW = size.w - 2 * REPORT_MARGIN;
  const top = REPORT_MARGIN + HEADER_HEIGHT;
  const bottom = size.h - REPORT_MARGIN - FOOTER_HEIGHT;
  const pages: ReportPage[] = [];
  let page: ReportPage = { index: 0, blocks: [] };
  let y = top;

  const newPage = (): void => {
    pages.push(page);
    page = { index: pages.length, blocks: [] };
    y = top;
  };

  // Title block on the first page.
  const fields = Object.entries(input.titleBlock).filter(([, v]) => v.trim().length > 0);
  page.blocks.push({ kind: 'title', title: input.name, fields, y });
  y += TITLE_HEIGHT + Math.ceil(fields.length / 2) * 14 + BLOCK_GAP;

  for (const chart of input.charts) {
    const withSnapshot = input.snapshots && chart.aggregation !== null && chart.aggregation.categories.length > 0;
    // Chart and snapshot side by side when the page is wide enough, stacked otherwise.
    const sideBySide = withSnapshot && contentW >= 640;
    const chartW = sideBySide ? Math.round(contentW * 0.6) - BLOCK_GAP / 2 : contentW;
    const graphicsH = 18 + (sideBySide ? Math.max(CHART_HEIGHT, SNAPSHOT_HEIGHT) : CHART_HEIGHT + (withSnapshot ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0)) + BLOCK_GAP;
    // The table takes what is left of the page under the graphics; the
    // graphics themselves always fit an empty page, so a block that does not
    // fit here starts a new page, and its table is cut to the space there.
    const fullTable = chart.aggregation ? bucketTable(chart.aggregation) : { head: ['Bucket', 'Elements', ''] as [string, string, string], rows: [] };
    const fullH = TABLE_HEAD_HEIGHT + fullTable.rows.length * TABLE_ROW_HEIGHT;
    if (y + graphicsH + Math.min(fullH, TABLE_HEAD_HEIGHT + 3 * TABLE_ROW_HEIGHT) > bottom && page.blocks.length > 0) newPage();
    const roomForRows = Math.floor((bottom - y - graphicsH - TABLE_HEAD_HEIGHT) / TABLE_ROW_HEIGHT);
    const table = chart.aggregation && roomForRows < fullTable.rows.length
      ? bucketTable(chart.aggregation, Math.max(0, roomForRows - 1))
      : fullTable;
    const tableH = TABLE_HEAD_HEIGHT + table.rows.length * TABLE_ROW_HEIGHT;

    const chartY = y + 18;
    const chartBox = { x: REPORT_MARGIN, y: chartY, w: chartW, h: CHART_HEIGHT };
    const snapshot = withSnapshot
      ? sideBySide
        ? { x: REPORT_MARGIN + chartW + BLOCK_GAP, y: chartY, w: contentW - chartW - BLOCK_GAP, h: SNAPSHOT_HEIGHT }
        : { x: REPORT_MARGIN, y: chartY + CHART_HEIGHT + BLOCK_GAP, w: contentW, h: SNAPSHOT_HEIGHT }
      : null;
    const tableY = chartY + (sideBySide ? Math.max(CHART_HEIGHT, SNAPSHOT_HEIGHT) : CHART_HEIGHT + (withSnapshot ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0)) + BLOCK_GAP;
    const agg = chart.aggregation;
    page.blocks.push({
      kind: 'chart',
      chartId: chart.id,
      title: chart.title,
      subtitle: agg
        ? `${agg.categories.length} bucket${agg.categories.length === 1 ? '' : 's'} · ${agg.total.toLocaleString()} ${agg.spec.measure.agg === 'count' ? 'elements' : (agg.unit ?? '')}`
        : 'No data',
      chart: chartBox,
      snapshot,
      table: { x: REPORT_MARGIN, y: tableY, w: contentW, rows: table.rows, head: table.head },
    });
    y = tableY + tableH + BLOCK_GAP;
  }
  pages.push(page);

  return {
    page: input.page,
    size,
    pages,
    header: input.name,
    footer: `Generated ${input.generatedAt} · ifc-lite`,
  };
}
