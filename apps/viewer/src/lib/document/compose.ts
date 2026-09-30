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
import { chartFontScale, type ReportPageSetup } from '@ifc-lite/charts';
import { pageBox, REPORT_MARGIN } from '../export/report/compose.js';
import { CHART_BLOCK_HEIGHT_DEFAULT, isHalfPairable, type BlockWidth, type PageBreakBlock, type TextBlock, type TextFont } from './types.js';
import { layoutTable, type LayoutCursor, type TableLayoutBlock, type TableDrawnItem } from './compose-table.js';
import { layoutIdsReport, type IdsReportLayoutBlock } from './compose-ids-report.js';
import { layoutManualReport, type ManualReportLayoutBlock, type RingDrawnItem } from './compose-manual-report.js';
import { blockTitle, BLOCK_TITLE_HEIGHT } from './block-title.js';
import { TEXT_STYLES, wrapText, truncateToWidth, layoutText, textBackground } from './compose-text.js';
export { TEXT_STYLES, wrapText, truncateToWidth } from './compose-text.js';
import { splitDocumentSections } from './page-sections.js';

import { resolvePageHeading, type PageHeading, type ResolvedPageHeading } from './page-heading.js';

const HEADER_HEIGHT = 30;
const FOOTER_HEIGHT = 24;
export const BLOCK_GAP = 10;
const CHART_HEIGHT = CHART_BLOCK_HEIGHT_DEFAULT;
const SNAPSHOT_HEIGHT = 180;
const TOPIC_SNAPSHOT_HEIGHT = 160;

export interface DocumentChartSizingInput {
  requestedHeight: number;
  pageHeight: number;
  boxWidth: number;
  snapshot: boolean;
  hasData: boolean;
  fontSize?: number;
  headingExtraHeight?: number;
}

/** One chart-height rule shared by PDF composition and the browser preview (#4940). */
export function documentChartSizing(input: DocumentChartSizingInput): { height: number; sideBySide: boolean; stacked: boolean } {
  const sideBySide = input.snapshot && input.hasData && input.boxWidth >= 640;
  const stacked = input.snapshot && input.hasData && !sideBySide;
  const overhead = 32 * chartFontScale(input.fontSize) + (stacked ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0);
  const printableHeight = input.pageHeight - (REPORT_MARGIN + HEADER_HEIGHT + (input.headingExtraHeight ?? 0)) - (REPORT_MARGIN + FOOTER_HEIGHT);
  return {
    height: Math.max(40, Math.min(input.requestedHeight, printableHeight - overhead)),
    sideBySide,
    stacked,
  };
}

/** The image and its optional heading/caption fit inside the printable frame. */
export function documentImageHeight(block: { height: number; title?: string; caption?: string }, pageHeight: number, headingExtraHeight = 0): number {
  return Math.min(block.height, pageHeight - 2 * REPORT_MARGIN - HEADER_HEIGHT - FOOTER_HEIGHT - headingExtraHeight - (blockTitle(block) ? BLOCK_TITLE_HEIGHT : 0) - (block.caption ? 14 : 0));
}

/** A block after its bindings were resolved and its assets measured — what layout needs. */
export type ResolvedBlock =
  | TextBlock
  | PageBreakBlock
  | { kind: 'image'; id: string; height: number; align: 'left' | 'center' | 'right'; caption?: string; title?: string; /** natural width / height */ aspect: number; width?: BlockWidth }
  | { kind: 'chart'; id: string; title: string; subtitle: string; hasData: boolean; snapshot: boolean; height?: number; width?: BlockWidth; fontSize?: number }
  | { kind: 'topic'; id: string; title: string; authoredTitle?: boolean; lines: string[]; /** null when there is no snapshot to print */ snapshotAspect: number | null }
  | { kind: 'spacer'; id: string; height: number }
  | ({ kind: 'table' } & TableLayoutBlock)
  | ({ kind: 'ids-report' } & IdsReportLayoutBlock)
  | ({ kind: 'manual-report' } & ManualReportLayoutBlock);

export type DrawnItem =
  | TableDrawnItem
  | { kind: 'text-background'; x: number; y: number; w: number; h: number; color: string }
  /** A manual-validation ring chart (#6401), drawn from its counts. */
  | RingDrawnItem
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
  pageHeading?: ResolvedPageHeading;
  footer: string;
}

export interface ComposeDocumentInput {
  name: string;
  pageHeading?: PageHeading;
  page: ReportPageSetup;
  blocks: ResolvedBlock[];
  generatedAt: string;
  /** Width of `text` at `size` points, in points. */
  measure: (text: string, size: number, bold: boolean, font?: TextFont) => number;
}

/** A character estimate for Helvetica — tests and the on-screen preview use it. */
export const estimateTextWidth = (text: string, size: number, bold: boolean): number => text.length * size * (bold ? 0.56 : 0.52);

/** A conservative, font-independent bound keeps preview/PDF pairing identical.
 * Standard PDF font glyphs fit within one em; this can choose full width early,
 * but never puts a two-column row through the footer for a wide glyph string. */
export function halfTextFitsPage(block: Pick<TextBlock, 'style' | 'text' | 'fontSize' | 'title'>, pageHeight: number, columnWidth: number, headingExtraHeight = 0): boolean {
  const style = TEXT_STYLES[block.style];
  const size = block.fontSize ?? style.size;
  const lines = wrapText(block.text, columnWidth, size, style.bold, (text, fontSize) => text.length * fontSize);
  const frameHeight = pageHeight - 2 * REPORT_MARGIN - HEADER_HEIGHT - FOOTER_HEIGHT - headingExtraHeight;
  return (blockTitle(block) ? BLOCK_TITLE_HEIGHT : 0) + style.gapBefore + lines.length * size * style.lineHeight <= frameHeight;
}

export function composeDocument(input: ComposeDocumentInput): DocumentLayout {
  const size = pageBox(input.page);
  const contentW = size.w - 2 * REPORT_MARGIN;
  const pageHeading = input.pageHeading ? resolvePageHeading(input.name, input.pageHeading, contentW, input.measure) : undefined;
  const headingExtraHeight = pageHeading?.extraHeight ?? 0;
  const top = REPORT_MARGIN + HEADER_HEIGHT + headingExtraHeight;
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
    // A page is "occupied" once the cursor has moved past `top`, not only once something was
    // actually drawn: a spacer advances `y` but draws no items, so `page.items.length > 0` alone
    // missed both a spacer that filled the page exactly (y === bottom) and one that only
    // partially filled it (top < y < bottom) — a 400pt spacer + a 400pt chart on A4 drew the
    // chart through the footer instead of starting page 2 in the latter case (review finding).
    if (y + h > bottom && (page.items.length > 0 || y > top)) newPage();
  };
  // The same cursor, as an object, for block layouts that live in their own module (#5142).
  const cursor: LayoutCursor = {
    get y() { return y; },
    set y(value: number) { y = value; },
    x: REPORT_MARGIN,
    top,
    bottom,
    ensure,
    newPage,
    push: (...items) => { page.items.push(...items); },
    truncate: (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure),
  };

  // Both a full-width chart/image and one half of a two-up row need the same
  // box measured against different widths, so the size and position math is
  // computed once per block and the actual `y` (known only after a possible
  // page break) is applied last, through `draw`.
  const layoutImage = (block: Extract<ResolvedBlock, { kind: 'image' }>, boxX: number, boxW: number): { height: number; draw: (y: number) => DrawnItem[] } => {
    // The caption's own row must fit the page frame too, so it is reserved before the image height
    // is clamped (review finding: a tall image + caption could still clamp to the full frame, then
    // draw the caption past `bottom`, in the footer band).
    const title = blockTitle(block);
    const titleH = title ? BLOCK_TITLE_HEIGHT : 0;
    const captionH = block.caption ? 14 : 0;
    const h = documentImageHeight(block, size.h, headingExtraHeight);
    const w = Math.min(boxW, h * block.aspect);
    const drawnH = w / block.aspect;
    const x = block.align === 'left' ? boxX : block.align === 'right' ? boxX + boxW - w : boxX + (boxW - w) / 2;
    return {
      height: drawnH + captionH + titleH,
      draw: (y) => {
        const items: DrawnItem[] = title ? [{ kind: 'text', x: boxX, y: y + 11, size: 11, bold: true, gray: 0, text: truncateToWidth(title, boxW, 11, true, input.measure) }] : [];
        y += titleH;
        items.push({ kind: 'image', blockId: block.id, x, y, w, h: drawnH });
        // A long caption must not cross the inter-column gap into the paired half-width block, and
        // for a centered/right-aligned narrow image it starts at `x > boxX`, so it is truncated to
        // the room actually left in the column from `x`, not the column's full width (review finding).
        if (block.caption) items.push({ kind: 'text', x, y: y + drawnH + 11, size: 8, bold: false, gray: 130, text: truncateToWidth(block.caption, boxX + boxW - x, 8, false, input.measure) });
        return items;
      },
    };
  };

  const layoutChart = (block: Extract<ResolvedBlock, { kind: 'chart' }>, boxX: number, boxW: number): { height: number; draw: (y: number) => DrawnItem[] } => {
    const textScale = chartFontScale(block.fontSize);
    // The configured height (up to CHART_BLOCK_HEIGHT_MAX, 600pt) must still fit a single page next to its
    // title strip and, when stacked, its snapshot — otherwise the SVG is clipped past the footer (review finding).
    const { height: chartHeight, sideBySide, stacked } = documentChartSizing({
      headingExtraHeight,
      requestedHeight: block.height ?? CHART_HEIGHT,
      pageHeight: size.h,
      boxWidth: boxW,
      snapshot: block.snapshot,
      hasData: block.hasData,
      fontSize: block.fontSize,
    });
    const chartW = sideBySide ? Math.round(boxW * 0.6) - BLOCK_GAP / 2 : boxW;
    const totalH = 32 * textScale + (sideBySide ? Math.max(chartHeight, SNAPSHOT_HEIGHT) : chartHeight + (stacked ? SNAPSHOT_HEIGHT + BLOCK_GAP : 0));
    return {
      height: totalH,
      draw: (y) => {
        // Give each line the column width. The old 80pt subtitle slot cut ordinary totals
        // such as "13 buckets · 12,623 elements" even on a full-width A4 chart (#4940).
        const title = truncateToWidth(block.title, boxW - 4, 11 * textScale, true, input.measure);
        const subtitle = truncateToWidth(block.subtitle, boxW - 4, 8 * textScale, false, input.measure);
        const items: DrawnItem[] = [
          { kind: 'text', x: boxX, y: y + 11 * textScale, size: 11 * textScale, bold: true, gray: 0, text: title },
          { kind: 'text', x: boxX, y: y + 24 * textScale, size: 8 * textScale, bold: false, gray: 130, text: subtitle },
        ];
        const chartY = y + 32 * textScale;
        items.push({ kind: 'chart', blockId: block.id, x: boxX, y: chartY, w: chartW, h: chartHeight });
        if (sideBySide) items.push({ kind: 'snapshot', blockId: block.id, x: boxX + chartW + BLOCK_GAP, y: chartY, w: boxW - chartW - BLOCK_GAP, h: SNAPSHOT_HEIGHT });
        else if (stacked) items.push({ kind: 'snapshot', blockId: block.id, x: boxX, y: chartY + chartHeight + BLOCK_GAP, w: boxW, h: SNAPSHOT_HEIGHT });
        return items;
      },
    };
  };

  const textLayout = (block: TextBlock, x: number, width: number) => layoutText(block, x, width, input.measure);
  const layoutPairable = (block: Extract<ResolvedBlock, { kind: 'text' | 'image' | 'chart' }>, boxX: number, boxW: number) =>
    block.kind === 'text' ? textLayout(block, boxX, boxW)
      : block.kind === 'chart' ? layoutChart(block, boxX, boxW)
      : layoutImage(block, boxX, boxW);

  const wrap = (text: string, width: number, size: number, bold: boolean) => wrapText(text, width, size, bold, input.measure);

  for (const [sectionIndex, blocks] of splitDocumentSections(input.blocks).entries()) {
    if (sectionIndex > 0 && (page.items.length > 0 || y > top)) newPage();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const next = blocks[i + 1];
      if (next && isHalfPairable(block) && isHalfPairable(next)) {
        const colW = (contentW - BLOCK_GAP) / 2;
        const textFits = (candidate: typeof block): boolean => candidate.kind !== 'text' || halfTextFitsPage(candidate, size.h, colW, headingExtraHeight);
        if (textFits(block) && textFits(next)) {
          const a = layoutPairable(block, REPORT_MARGIN, colW);
          const b = layoutPairable(next, REPORT_MARGIN + colW + BLOCK_GAP, colW);
          const rowH = Math.max(a.height, b.height);
          // An oversized text column falls back to the ordinary paginated text path.
          if (rowH <= bottom - top) {
            ensure(rowH + BLOCK_GAP);
            page.items.push(...a.draw(y), ...b.draw(y));
            y += rowH + BLOCK_GAP;
            i += 1;
            continue;
          }
        }
      }
      switch (block.kind) {
        case 'text': {
          const { style, size, lineH, lines, title, titleHeight } = textLayout(block, REPORT_MARGIN, contentW);
          if (!title && !block.backgroundColor && lines.every((l) => l.length === 0)) {
            y += lineH;
            break;
          }
          if (title) {
            ensure(titleHeight + style.gapBefore + lineH * Math.min(lines.length, 2));
            page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + 11, size: 11, bold: true, gray: 0, text: truncateToWidth(title, contentW, 11, true, input.measure) });
            y += titleHeight;
          }
          y += style.gapBefore;
          // A heading is not left alone at the bottom of a page: the first two lines move together.
          ensure(lineH * Math.min(lines.length, 2));
          for (const line of lines) {
            if (y + lineH > bottom) newPage();
            page.items.push(...textBackground(block, REPORT_MARGIN, y, contentW, lineH), { kind: 'text', x: REPORT_MARGIN, y: y + size, size, bold: style.bold, gray: style.gray, text: line, font: block.font, color: block.textColor });
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
          const single = block.kind === 'chart' ? layoutChart(block, REPORT_MARGIN, contentW) : layoutImage(block, REPORT_MARGIN, contentW);
          ensure(single.height + BLOCK_GAP);
          page.items.push(...single.draw(y));
          y += single.height + BLOCK_GAP;
          break;
        }
        case 'table': {
          layoutTable(block, cursor, contentW, input.measure, BLOCK_GAP, (text, width, size, bold) => wrapText(text, width, size, bold, input.measure));
          break;
        }
        case 'ids-report': {
          layoutIdsReport(block, cursor, contentW, BLOCK_GAP, wrap);
          break;
        }
        case 'manual-report': {
          layoutManualReport(block, cursor, contentW, BLOCK_GAP, wrap, (ring) => { page.items.push(ring); });
          break;
        }
        case 'topic': {
          const lineH = 10 * 1.4;
          const snapshotW = block.snapshotAspect ? Math.min(190, TOPIC_SNAPSHOT_HEIGHT * block.snapshotAspect) : 0;
          const snapshotH = block.snapshotAspect ? snapshotW / block.snapshotAspect : 0;
          const textW = contentW - (snapshotW ? snapshotW + BLOCK_GAP : 0);
          const lines = block.lines.flatMap((l) => wrapText(l, textW, 10, false, input.measure));
          // Title, snapshot and the first lines move together; a long description then continues page by page.
          ensure(Math.max(16 + Math.min(lines.length, 3) * lineH, snapshotH) + BLOCK_GAP);
          page.items.push({ kind: 'text', x: REPORT_MARGIN, y: y + 11, size: 11, bold: true, gray: 0, text: block.authoredTitle ? truncateToWidth(block.title, textW, 11, true, input.measure) : block.title });
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
  }
  pages.push(page);

  return { page: input.page, size, pages, header: input.name, ...(pageHeading ? { pageHeading } : {}), footer: `Generated ${input.generatedAt} · ifc-lite` };
}
