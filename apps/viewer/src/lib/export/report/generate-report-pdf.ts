/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Draw a composed report (`compose.ts`) into a PDF (#3944): vector charts
 * through ECharts' SVG renderer and svg2pdf, 3D snapshots as PNG, bucket
 * tables through jspdf-autotable, running header + page numbers.
 *
 * Every outside dependency is a seam (`ReportPdfSeams`) with a browser
 * default, the way `view-pdf` does it, so the sequence — page breaks, what
 * is drawn where, that a failed snapshot does not abort the report — runs
 * under node:test against a recording document.
 */
import { renderChartSvg, type Aggregation, type ChartTheme, DEFAULT_THEME } from '@ifc-lite/charts';
import { composeReport, REPORT_MARGIN, type ComposeReportInput, type ReportChartBlock, type ReportLayout } from './compose.js';
import type { SnapshotCapture } from './snapshots.js';

/** The subset of jsPDF the generator drives; a test records the calls. */
export interface ReportDoc {
  addPage: (format: 'a4' | 'a3', orientation: 'portrait' | 'landscape') => void;
  setFont: (family: string, style: 'normal' | 'bold') => void;
  setFontSize: (size: number) => void;
  setTextColor: (gray: number) => void;
  text: (text: string, x: number, y: number) => void;
  addImage: (bytes: Uint8Array, format: 'PNG', x: number, y: number, w: number, h: number) => void;
  /** Draw an SVG string into the box (svg2pdf); a raster fallback is the caller's business. */
  svg: (svg: string, x: number, y: number, w: number, h: number) => Promise<void>;
  table: (args: { startY: number; margin: { left: number; right: number }; head: string[][]; body: string[][] }) => void;
  pageCount: () => number;
  output: () => Blob;
}

export interface ReportPdfSeams {
  createDoc: (format: 'a4' | 'a3', orientation: 'portrait' | 'landscape') => Promise<ReportDoc>;
  renderSvg: (aggregation: Aggregation, width: number, height: number, theme: ChartTheme) => string;
  /** `null` when no renderer is available; snapshots are then skipped. */
  capture: SnapshotCapture | null;
  theme: ChartTheme;
  now: () => Date;
}

export interface ReportPdfInput extends Omit<ComposeReportInput, 'generatedAt'> {
  /** Ids of the elements of each chart's largest bucket, for the snapshot. */
  snapshotIds: (chartId: string) => readonly number[];
}

export interface ReportPdfResult {
  blob: Blob;
  pages: number;
  charts: number;
  snapshots: number;
  /** Charts whose snapshot could not be captured; the report says so in its place. */
  snapshotFailures: string[];
}

/**
 * The report prints on white with a font jsPDF ships, whatever the app's
 * theme: the screen theme's font stack carries quoted family names
 * (`"Segoe UI"`) that break the chart SVG as XML, and its dark tokens
 * would print light-on-white.
 */
export const REPORT_THEME: ChartTheme = { ...DEFAULT_THEME, fontFamily: 'Helvetica, Arial, sans-serif' };

/** The browser seams: real jsPDF + autotable + svg2pdf, lazily imported. */
export async function browserReportSeams(capture: SnapshotCapture | null, theme: ChartTheme = REPORT_THEME): Promise<ReportPdfSeams> {
  return {
    createDoc: async (format, orientation) => {
      const { jsPDF } = await import('jspdf');
      const autoTable = (await import('jspdf-autotable')).default;
      await import('svg2pdf.js');
      const doc = new jsPDF({ orientation, unit: 'pt', format });
      const parser = new DOMParser();
      return {
        addPage: (f, o) => { doc.addPage(f, o); },
        setFont: (family, style) => { doc.setFont(family, style); },
        setFontSize: (size) => { doc.setFontSize(size); },
        setTextColor: (gray) => { doc.setTextColor(gray); },
        text: (t, x, y) => { doc.text(t, x, y); },
        addImage: (bytes, format, x, y, w, h) => { doc.addImage(bytes, format, x, y, w, h); },
        svg: async (svg, x, y, w, h) => {
          const parsed = parser.parseFromString(svg, 'image/svg+xml');
          const error = parsed.querySelector('parsererror');
          if (error) throw new Error(`Chart SVG did not parse: ${error.textContent ?? ''}`);
          // svg2pdf measures text and resolves styles through the live DOM,
          // so the element is attached (off-screen) for the duration.
          const host = document.createElement('div');
          host.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden';
          const el = document.adoptNode(parsed.documentElement);
          host.appendChild(el);
          document.body.appendChild(host);
          try {
            await doc.svg(el, { x, y, width: w, height: h });
          } finally {
            host.remove();
          }
        },
        table: ({ startY, margin, head, body }) => {
          autoTable(doc, {
            startY, margin: { ...margin, top: REPORT_MARGIN, bottom: REPORT_MARGIN }, head, body,
            styles: { fontSize: 8, cellPadding: 2, overflow: 'ellipsize', lineColor: [226, 232, 240], lineWidth: 0.5 },
            headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold' },
            columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
          });
        },
        pageCount: () => doc.getNumberOfPages(),
        output: () => doc.output('blob'),
      };
    },
    renderSvg: (aggregation, width, height, t) => renderChartSvg({ aggregation, width, height, theme: t, showTitle: false }),
    capture,
    theme,
    now: () => new Date(),
  };
}

function drawHeaderFooter(doc: ReportDoc, layout: ReportLayout, pageIndex: number): void {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text(layout.header, REPORT_MARGIN, REPORT_MARGIN - 8);
  doc.text(layout.footer, REPORT_MARGIN, layout.size.h - REPORT_MARGIN + 12);
  doc.text(`Page ${pageIndex + 1} / ${layout.pages.length}`, layout.size.w - REPORT_MARGIN - 60, layout.size.h - REPORT_MARGIN + 12);
  doc.setTextColor(0);
}

async function drawChartBlock(doc: ReportDoc, block: ReportChartBlock, aggregation: Aggregation | null, seams: ReportPdfSeams, snapshotIds: readonly number[], result: ReportPdfResult): Promise<void> {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0);
  doc.text(block.title, block.chart.x, block.chart.y - 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(130);
  doc.text(block.subtitle, block.chart.x + Math.min(block.chart.w - 80, block.title.length * 6 + 12), block.chart.y - 6);
  doc.setTextColor(0);

  if (aggregation && aggregation.categories.length > 0) {
    await doc.svg(seams.renderSvg(aggregation, block.chart.w, block.chart.h, seams.theme), block.chart.x, block.chart.y, block.chart.w, block.chart.h);
    result.charts += 1;
  } else {
    doc.setTextColor(130);
    doc.text('No data for this chart.', block.chart.x, block.chart.y + 14);
    doc.setTextColor(0);
  }

  if (block.snapshot) {
    let png: Uint8Array | undefined;
    try {
      png = await seams.capture?.(snapshotIds);
    } catch (err) {
      console.warn(`[Charts] snapshot failed for "${block.title}"`, err);
    }
    if (png) {
      doc.addImage(png, 'PNG', block.snapshot.x, block.snapshot.y, block.snapshot.w, block.snapshot.h);
      result.snapshots += 1;
    } else {
      result.snapshotFailures.push(block.title);
      doc.setTextColor(130);
      doc.text('3D snapshot unavailable.', block.snapshot.x, block.snapshot.y + 14);
      doc.setTextColor(0);
    }
  }

  if (block.table.rows.length > 0) {
    doc.table({
      startY: block.table.y,
      margin: { left: block.table.x, right: REPORT_MARGIN },
      head: [block.table.head.filter((h, i) => i < 2 || h.length > 0)],
      body: block.table.rows.map((r) => (block.table.head[2].length > 0 ? r : [r[0], r[1]])),
    });
  }
}

export async function generateReportPdf(input: ReportPdfInput, seams: ReportPdfSeams): Promise<ReportPdfResult> {
  const generatedAt = seams.now().toLocaleString();
  const layout = composeReport({ ...input, generatedAt });
  const format = input.page.size === 'A3' ? 'a3' : 'a4';
  const doc = await seams.createDoc(format, input.page.orientation);
  const aggregations = new Map(input.charts.map((c) => [c.id, c.aggregation]));
  const result: ReportPdfResult = { blob: new Blob(), pages: 0, charts: 0, snapshots: 0, snapshotFailures: [] };

  for (const page of layout.pages) {
    if (page.index > 0) doc.addPage(format, input.page.orientation);
    drawHeaderFooter(doc, layout, page.index);
    for (const block of page.blocks) {
      if (block.kind === 'title') {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(0);
        doc.text(block.title, REPORT_MARGIN, block.y + 20);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        block.fields.forEach(([label, value], i) => {
          const col = i % 2;
          const row = Math.floor(i / 2);
          doc.setTextColor(130);
          doc.text(`${label}:`, REPORT_MARGIN + col * (layout.size.w / 2 - REPORT_MARGIN), block.y + 40 + row * 14);
          doc.setTextColor(0);
          doc.text(value, REPORT_MARGIN + col * (layout.size.w / 2 - REPORT_MARGIN) + 70, block.y + 40 + row * 14);
        });
      } else {
        await drawChartBlock(doc, block, aggregations.get(block.chartId) ?? null, seams, input.snapshotIds(block.chartId), result);
      }
    }
  }

  result.pages = doc.pageCount();
  result.blob = doc.output();
  return result;
}
