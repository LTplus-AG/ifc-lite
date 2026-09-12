/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The document's page model (#4594): resolved blocks laid out into pages of
 * the chosen size, page breaks included, as a pure description the PDF
 * generator draws and a test asserts. Text is wrapped here with an
 * injectable measure (jsPDF's in the browser, a character estimate in
 * tests), so the pagination is the same one the PDF gets.
 *
 * Units are PDF points; page sizes and margin come from the report's
 * `compose.ts` so a document and a report share a frame.
 */
import type { ReportPageSetup } from '@ifc-lite/charts';
import { pageBox, REPORT_MARGIN } from '../export/report/compose.js';
import type { TextBlock } from './types.js';

const HEADER_HEIGHT = 30;
const FOOTER_HEIGHT = 24;
const BLOCK_GAP = 10;
const CHART_HEIGHT = 220;
const SNAPSHOT_HEIGHT = 180;
const TOPIC_SNAPSHOT_HEIGHT = 160;

export const TEXT_STYLES: Record<TextBlock['style'], { size: number; bold: boolean; lineHeight: number; gapBefore: number }> = {
  title: { size: 20, bold: true, lineHeight: 1.3, gapBefore: 6 },
  heading: { size: 13, bold: true, lineHeight: 1.35, gapBefore: 8 },
  body: { size: 10, bold: false, lineHeight: 1.4, gapBefore: 0 },
};

/** A block after its bindings were resolved and its assets measured — what layout needs. */
export type ResolvedBlock =
  | { kind: 'text'; id: string; style: TextBlock['style']; text: string }
  | { kind: 'image'; id: string; height: number; align: 'left' | 'center' | 'right'; caption?: string; /** natural width / height */ aspect: number }
  | { kind: 'chart'; id: string; title: string; subtitle: string; hasData: boolean; snapshot: boolean }
  | { kind: 'topic'; id: string; title: string; lines: string[]; /** null when there is no snapshot to print */ snapshotAspect: number | null };

export type DrawnItem =
  | { kind: 'text'; x: number; y: number; size: number; bold: boolean; gray: number; text: string }
  | { kind: 'image'; blockId: string; x: number; y: number; w: number; h: number }
  | { kind: 'chart'; blockId: string; x: number; y: number; w: number; h: number }
  | { kind: 'snapshot'; blockId: string; x: number; y: number; w: number; h: number }
  | { kind: 'topic-snapshot'; blockId: string; x: number; y: number; w: number; h: number };

export interface DocumentPage {
  index: number;
  items: DrawnItem[];
}

export interface DocumentLayout {
  page: ReportPageSetup;
  size: { w: number; h: number };
  pages: DocumentPage[];
  header: string;
  footer: string;
}

export interface ComposeDocumentInput {
  name: string;
  page: ReportPageSetup;
  blocks: ResolvedBlock[];
  generatedAt: string;
  /** Width of `text` at `size` points, in points. */
  measure: (text: string, size: number, bold: boolean) => number;
}

/** A character estimate for Helvetica — tests and the on-screen preview use it. */
export const estimateTextWidth = (text: string, size: number, bold: boolean): number => text.length * size * (bold ? 0.56 : 0.52);

/** Greedy word wrap on the measure; a word longer than the line is broken by characters. */
export function wrapText(text: string, width: number, size: number, bold: boolean, measure: ComposeDocumentInput['measure']): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size, bold) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (measure(line, size, bold) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), size, bold) > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function composeDocument(input: ComposeDocumentInput): DocumentLayout {
  const size = pageBox(input.page);
  const contentW = size.w - 2 * REPORT_MARGIN;
  const top = REPORT_MARGIN + HEADER_HEIGHT;
  const bottom = size.h - REPORT_MARGIN - FOOTER_HEIGHT;
  const pages: DocumentPage[] = [];
  let page: DocumentPage = { index: 0, items: [] };
  let y = top;

  const newPage = (): void => {
    pages.push(page);
    page = { index: pages.length, items: [] };
    y = top;
  };
  const ensure = (h: number): void => {
    if (y + h > bottom && page.items.length > 0) newPage();
  };

  for (const block of input.blocks) {
    switch (block.kind) {
      case 'text': {
        const style = TEXT_STYLES[block.style];
        const lineH = style.size * style.lineHeight;
        const lines = wrapText(block.text, contentW, style.size, style.bold, input.measure);
        if (lines.every((l) => l.length === 0)) {
          y += lineH;
          break;
        }
        y += style.gapBefore;
        // A heading is not left alone at the bottom of a page: the first two lines move together.
        ensure(lineH * Math.min(lines.length, 2));
        for (const line of lines) {
          if (y + lineH > bottom) newPage();
          page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + style.size, size: style.size, bold: style.bold, gray: 0, text: line });
          y += lineH;
        }
        y += BLOCK_GAP;
        break;
      }
      case 'image': {
        const h = Math.min(block.height, bottom - top);
        const w = Math.min(contentW, h * block.aspect);
        const drawnH = w / block.aspect;
        const captionH = block.caption ? 14 : 0;
        ensure(drawnH + captionH + BLOCK_GAP);
        const x = block.align === 'left' ? REPORT_MARGIN : block.align === 'right' ? size.w - REPORT_MARGIN - w : REPORT_MARGIN + (contentW - w) / 2;
        page.items.push({ kind: 'image', blockId: block.id, x, y, w, h: drawnH });
        y += drawnH;
        if (block.caption) {
          page.items.push({ kind: 'text', x, y: y + 11, size: 8, bold: false, gray: 130, text: block.caption });
          y += captionH;
        }
        y += BLOCK_GAP;
        break;
      }
      case 'chart': {
        const sideBySide = block.snapshot && block.hasData && contentW >= 640;
        const stacked = block.snapshot && block.hasData && !sideBySide;
        const chartW = sideBySide ? Math.round(contentW * 0.6) - BLOCK_GAP / 2 : contentW;
        const totalH = 18 + (sideBySide ? Math.max(CHART_HEIGHT, SNAPSHOT_HEIGHT) : CHART_HEIGHT + (stacked ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0));
        ensure(totalH + BLOCK_GAP);
        page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + 11, size: 11, bold: true, gray: 0, text: block.title });
        page.items.push({ kind: 'text', x: REPORT_MARGIN + Math.min(contentW - 80, block.title.length * 6 + 12), y: y + 11, size: 8, bold: false, gray: 130, text: block.subtitle });
        const chartY = y + 18;
        page.items.push({ kind: 'chart', blockId: block.id, x: REPORT_MARGIN, y: chartY, w: chartW, h: CHART_HEIGHT });
        if (sideBySide) page.items.push({ kind: 'snapshot', blockId: block.id, x: REPORT_MARGIN + chartW + BLOCK_GAP, y: chartY, w: contentW - chartW - BLOCK_GAP, h: SNAPSHOT_HEIGHT });
        else if (stacked) page.items.push({ kind: 'snapshot', blockId: block.id, x: REPORT_MARGIN, y: chartY + CHART_HEIGHT + BLOCK_GAP, w: contentW, h: SNAPSHOT_HEIGHT });
        y += totalH + BLOCK_GAP;
        break;
      }
      case 'topic': {
        const lineH = 10 * 1.4;
        const snapshotW = block.snapshotAspect ? Math.min(190, TOPIC_SNAPSHOT_HEIGHT * block.snapshotAspect) : 0;
        const snapshotH = block.snapshotAspect ? snapshotW / block.snapshotAspect : 0;
        const lines = block.lines.flatMap((l) => wrapText(l, contentW - (snapshotW ? snapshotW + BLOCK_GAP : 0), 10, false, input.measure));
        // Title, snapshot and the first lines move together; a long description then continues page by page.
        ensure(Math.max(16 + Math.min(lines.length, 3) * lineH, snapshotH) + BLOCK_GAP);
        page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + 11, size: 11, bold: true, gray: 0, text: block.title });
        if (block.snapshotAspect) page.items.push({ kind: 'topic-snapshot', blockId: block.id, x: size.w - REPORT_MARGIN - snapshotW, y, w: snapshotW, h: snapshotH });
        const snapshotBottom = y + snapshotH;
        let ty = y + 16;
        for (const line of lines) {
          if (ty + lineH > bottom) {
            newPage();
            ty = y;
          }
          page.items.push({ kind: 'text', x: REPORT_MARGIN, y: ty + 10, size: 10, bold: false, gray: 60, text: line });
          ty += lineH;
        }
        y = Math.max(ty, page.items.some((i) => i.kind === 'topic-snapshot' && i.blockId === block.id) ? snapshotBottom : ty) + BLOCK_GAP;
        break;
      }
    }
  }
  pages.push(page);

  return { page: input.page, size, pages, header: input.name, footer: `Generated ${input.generatedAt} · ifc-lite` };
}
