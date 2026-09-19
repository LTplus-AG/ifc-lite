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
import { CHART_BLOCK_HEIGHT_DEFAULT, type BlockWidth, type TextBlock } from './types.js';

const HEADER_HEIGHT = 30;
const FOOTER_HEIGHT = 24;
const BLOCK_GAP = 10;
const CHART_HEIGHT = CHART_BLOCK_HEIGHT_DEFAULT;
const SNAPSHOT_HEIGHT = 180;
const TOPIC_SNAPSHOT_HEIGHT = 160;

export const TEXT_STYLES: Record<TextBlock['style'], { size: number; bold: boolean; lineHeight: number; gapBefore: number; gray: number }> = {
  title: { size: 20, bold: true, lineHeight: 1.3, gapBefore: 6, gray: 0 },
  heading: { size: 13, bold: true, lineHeight: 1.35, gapBefore: 8, gray: 0 },
  subheading: { size: 11, bold: true, lineHeight: 1.3, gapBefore: 6, gray: 0 },
  body: { size: 10, bold: false, lineHeight: 1.4, gapBefore: 0, gray: 0 },
  small: { size: 8.5, bold: false, lineHeight: 1.35, gapBefore: 0, gray: 0 },
  // Matches the image-caption text below (size 8, gray 130).
  caption: { size: 8, bold: false, lineHeight: 1.3, gapBefore: 2, gray: 130 },
};

/** A block after its bindings were resolved and its assets measured — what layout needs. */
export type ResolvedBlock =
  | { kind: 'text'; id: string; style: TextBlock['style']; text: string }
  | { kind: 'image'; id: string; height: number; align: 'left' | 'center' | 'right'; caption?: string; /** natural width / height */ aspect: number; width?: BlockWidth }
  | { kind: 'chart'; id: string; title: string; subtitle: string; hasData: boolean; snapshot: boolean; height?: number; width?: BlockWidth }
  | { kind: 'topic'; id: string; title: string; lines: string[]; /** null when there is no snapshot to print */ snapshotAspect: number | null }
  | { kind: 'spacer'; id: string; height: number };

/** `true` when `block` may pair with an adjacent `'half'` block into one row (#4940) — chart and image only. */
function isHalfPairable(block: ResolvedBlock): block is (Extract<ResolvedBlock, { kind: 'chart' | 'image' }>) & { width: 'half' } {
  return (block.kind === 'chart' || block.kind === 'image') && block.width === 'half';
}

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

/** A single line, ellipsis-truncated to fit `width` by the same measure `wrapText` uses (#4940 review: a half-width chart's title/subtitle must not run into the next column). */
function truncateToWidth(text: string, width: number, size: number, bold: boolean, measure: ComposeDocumentInput['measure']): string {
  if (width <= 0 || measure(text, size, bold) <= width) return text;
  let cut = text.length;
  while (cut > 0 && measure(`${text.slice(0, cut)}…`, size, bold) > width) cut -= 1;
  return cut > 0 ? `${text.slice(0, cut)}…` : '…';
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

  // Both a full-width chart/image and one half of a two-up row need the same
  // box measured against different widths, so the size and position math is
  // computed once per block and the actual `y` (known only after a possible
  // page break) is applied last, through `draw`.
  const layoutImage = (block: Extract<ResolvedBlock, { kind: 'image' }>, boxX: number, boxW: number): { height: number; draw: (y: number) => DrawnItem[] } => {
    const h = Math.min(block.height, bottom - top);
    const w = Math.min(boxW, h * block.aspect);
    const drawnH = w / block.aspect;
    const captionH = block.caption ? 14 : 0;
    const x = block.align === 'left' ? boxX : block.align === 'right' ? boxX + boxW - w : boxX + (boxW - w) / 2;
    return {
      height: drawnH + captionH,
      draw: (y) => {
        const items: DrawnItem[] = [{ kind: 'image', blockId: block.id, x, y, w, h: drawnH }];
        // A long caption must not cross the inter-column gap into the paired half-width block (review finding).
        if (block.caption) items.push({ kind: 'text', x, y: y + drawnH + 11, size: 8, bold: false, gray: 130, text: truncateToWidth(block.caption, boxW, 8, false, input.measure) });
        return items;
      },
    };
  };

  const layoutChart = (block: Extract<ResolvedBlock, { kind: 'chart' }>, boxX: number, boxW: number): { height: number; draw: (y: number) => DrawnItem[] } => {
    const sideBySide = block.snapshot && block.hasData && boxW >= 640;
    const stacked = block.snapshot && block.hasData && !sideBySide;
    // The configured height (up to CHART_BLOCK_HEIGHT_MAX, 600pt) must still fit a single page next to its
    // title strip and, when stacked, its snapshot — otherwise the SVG is clipped past the footer (review finding).
    const overhead = 18 + (stacked ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0);
    const chartHeight = Math.max(40, Math.min(block.height ?? CHART_HEIGHT, bottom - top - overhead));
    const chartW = sideBySide ? Math.round(boxW * 0.6) - BLOCK_GAP / 2 : boxW;
    const totalH = 18 + (sideBySide ? Math.max(chartHeight, SNAPSHOT_HEIGHT) : chartHeight + (stacked ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0));
    return {
      height: totalH,
      draw: (y) => {
        // A half-width column must not let a long title/subtitle run into the next column (review finding).
        // The title's own width is capped to the same room the subtitle reserves for itself
        // (review finding: `boxW - 8` let a long title run under/into the subtitle it sits next to).
        const title = truncateToWidth(block.title, Math.max(20, boxW - 80), 11, true, input.measure);
        const items: DrawnItem[] = [
          { kind: 'text', x: boxX, y: y + 11, size: 11, bold: true, gray: 0, text: title },
        ];
        const subtitleX = boxX + Math.max(20, boxW - 80);
        const subtitle = truncateToWidth(block.subtitle, Math.max(20, boxX + boxW - subtitleX - 4), 8, false, input.measure);
        items.push({ kind: 'text', x: subtitleX, y: y + 11, size: 8, bold: false, gray: 130, text: subtitle });
        const chartY = y + 18;
        items.push({ kind: 'chart', blockId: block.id, x: boxX, y: chartY, w: chartW, h: chartHeight });
        if (sideBySide) items.push({ kind: 'snapshot', blockId: block.id, x: boxX + chartW + BLOCK_GAP, y: chartY, w: boxW - chartW - BLOCK_GAP, h: SNAPSHOT_HEIGHT });
        else if (stacked) items.push({ kind: 'snapshot', blockId: block.id, x: boxX, y: chartY + chartHeight + BLOCK_GAP, w: boxW, h: SNAPSHOT_HEIGHT });
        return items;
      },
    };
  };

  for (let i = 0; i < input.blocks.length; i++) {
    const block = input.blocks[i];
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
          page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + style.size, size: style.size, bold: style.bold, gray: style.gray, text: line });
          y += lineH;
        }
        y += BLOCK_GAP;
        break;
      }
      case 'spacer': {
        // A spacer taller than the printable page would otherwise push every following item past
        // the footer, since `ensure` only starts one fresh page (review finding).
        const height = Math.min(block.height, bottom - top);
        ensure(height);
        y += height;
        break;
      }
      case 'image':
      case 'chart': {
        const next = input.blocks[i + 1];
        const pairWithNext = isHalfPairable(block) && next !== undefined && isHalfPairable(next);
        if (pairWithNext) {
          const colW = (contentW - BLOCK_GAP) / 2;
          const a = block.kind === 'chart' ? layoutChart(block, REPORT_MARGIN, colW) : layoutImage(block, REPORT_MARGIN, colW);
          const b = next.kind === 'chart' ? layoutChart(next, REPORT_MARGIN + colW + BLOCK_GAP, colW) : layoutImage(next, REPORT_MARGIN + colW + BLOCK_GAP, colW);
          const rowH = Math.max(a.height, b.height);
          ensure(rowH + BLOCK_GAP);
          page.items.push(...a.draw(y), ...b.draw(y));
          y += rowH + BLOCK_GAP;
          i += 1; // the next block was drawn as this row's second column
          break;
        }
        const single = block.kind === 'chart' ? layoutChart(block, REPORT_MARGIN, contentW) : layoutImage(block, REPORT_MARGIN, contentW);
        ensure(single.height + BLOCK_GAP);
        page.items.push(...single.draw(y));
        y += single.height + BLOCK_GAP;
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
