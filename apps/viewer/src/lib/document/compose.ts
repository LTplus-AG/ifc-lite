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
import { scaledPageHeight, zoomItem, scaledFrame } from './compose-scale.js';
export { scaledPageHeight } from './compose-scale.js';
import { BLOCK_GAP, documentChartLayout, documentImageHeight, pageFrameHeight, rowFitsFrame } from './compose-sizing.js';
export { BLOCK_GAP, documentChartSizing, documentImageHeight, pageFrameHeight, rowFitsFrame } from './compose-sizing.js';
import { pageBox, REPORT_MARGIN } from '../export/report/compose.js';
import { blockScale, CHART_BLOCK_HEIGHT_DEFAULT, isHalfPairable, type BlockWidth, type PageBreakBlock, type TextBlock, type TextFont } from './types.js';
import { layoutTable, type TableLayoutBlock, type TableDrawnItem } from './compose-table.js';
import { layoutIdsReport, type IdsReportLayoutBlock } from './compose-ids-report.js';
import { layoutManualReport, type ManualReportLayoutBlock, type RingDrawnItem } from './compose-manual-report.js';
import { blockTitle, blockTitleStyle, BLOCK_TITLE_HEIGHT, BLOCK_TITLE_SIZE_DEFAULT, type BlockHeaderStyleFields } from './block-title.js';
import { blockTitleItems, CHART_TITLE_RESERVE } from './compose-block-title.js';
import { TEXT_STYLES, wrapText, truncateToWidth, layoutText, textBackground } from './compose-text.js';
export { TEXT_STYLES, wrapText, truncateToWidth } from './compose-text.js';
import type { ResolvedBindingSpan } from './bindings.js';
import { splitDocumentSections } from './page-sections.js';

import { type PageHeading, type ResolvedPageHeading } from './page-heading.js';
import { resolveEnglish } from '@/i18n/registry';
import { composePageFrame, type PageFrameItem } from './compose-page-frame.js';
import type { PageBand } from './page-band.js';
import type { DocumentLabelFormatter } from './document-labels.js';

const CHART_HEIGHT = CHART_BLOCK_HEIGHT_DEFAULT;
const TOPIC_SNAPSHOT_HEIGHT = 160;

/** A block after its bindings were resolved and its assets measured — what layout needs. */
export type ResolvedBlock =
  | (TextBlock & { bindingSpans?: ResolvedBindingSpan[] })
  | PageBreakBlock
  | ({ kind: 'image'; id: string; height: number; align: 'left' | 'center' | 'right'; caption?: string; title?: string; /** natural width / height */ aspect: number; width?: BlockWidth; scale?: number } & BlockHeaderStyleFields)
  | ({ kind: 'chart'; id: string; title: string; subtitle: string; hasData: boolean; snapshot: boolean; height?: number; width?: BlockWidth; fontSize?: number; scale?: number } & BlockHeaderStyleFields)
  | ({ kind: 'topic'; id: string; title: string; lines: string[]; /** null when there is no snapshot to print */ snapshotAspect: number | null; scale?: number } & BlockHeaderStyleFields)
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
  /** `scale` is the block's size factor (#6548): the chart is rendered at `w / scale` by `h / scale`, then placed into `w` by `h`. */
  | { kind: 'chart'; blockId: string; x: number; y: number; w: number; h: number; scale?: number }
  | { kind: 'snapshot'; blockId: string; x: number; y: number; w: number; h: number }
  | { kind: 'topic-snapshot'; blockId: string; x: number; y: number; w: number; h: number };

export interface DocumentPage {
  index: number;
  items: DrawnItem[];
  /** Parallel source identities let preview select the authored block on every overflow page (#6610). */
  blockIds?: string[];
  /** Blank text and spacers retain an interactive region without adding PDF ink. */
  emptyBlocks?: Array<{ blockId: string; x: number; y: number; w: number; h: number }>;
}

export interface DocumentLayout {
  page: ReportPageSetup;
  size: { w: number; h: number };
  pages: DocumentPage[];
  header: string;
  pageHeading?: ResolvedPageHeading;
  footer: string;
  /** Already formatted counter text for each composed page. */
  pageCounters?: string[];
  /** Resolved repeated frame items, shared verbatim by preview and PDF. */
  pageFrames: PageFrameItem[][];
}

export interface ComposeDocumentInput {
  name: string;
  pageHeading?: PageHeading;
  pageFooter?: PageBand;
  logoAspects?: ReadonlyMap<string, number>;
  stampedDate?: string;
  page: ReportPageSetup;
  blocks: ResolvedBlock[];
  generatedAt: string;
  labels?: DocumentLabelFormatter;
  /** Width of `text` at `size` points, in points. */
  measure: (text: string, size: number, bold: boolean, font?: TextFont) => number;
}

/** A character estimate for Helvetica used by layout tests; preview/PDF use jsPDF metrics. */
export const estimateTextWidth = (text: string, size: number, bold: boolean): number => text.length * size * (bold ? 0.56 : 0.52);

/** A conservative, font-independent bound keeps preview/PDF pairing identical.
 * Standard PDF font glyphs fit within one em; this can choose full width early,
 * but never puts a two-column row through the footer for a wide glyph string. */
export function halfTextFitsPage(block: Pick<TextBlock, 'style' | 'text' | 'fontSize' | 'title' | keyof BlockHeaderStyleFields>, pageHeight: number, columnWidth: number, headingExtraHeight = 0, printableHeight?: number): boolean {
  const style = TEXT_STYLES[block.style];
  const size = block.fontSize ?? style.size;
  const lines = wrapText(block.text, columnWidth, size, style.bold, (text, fontSize) => text.length * fontSize);
  const frameHeight = printableHeight ?? pageFrameHeight(pageHeight, headingExtraHeight);
  return (blockTitle(block) ? BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra : 0) + style.gapBefore + lines.length * size * style.lineHeight <= frameHeight;
}

export function composeDocument(input: ComposeDocumentInput): DocumentLayout {
  const labels = input.labels ?? resolveEnglish;
  const size = pageBox(input.page);
  const contentW = size.w - 2 * REPORT_MARGIN;
  const pageFrame = composePageFrame(input, size, labels);
  const pageHeading = pageFrame.heading;
  const headingExtraHeight = pageHeading?.extraHeight ?? 0;
  const { top, bottom } = pageFrame;
  const printableHeight = bottom - top;
  const pages: DocumentPage[] = [];
  let page: DocumentPage = { index: 0, items: [], blockIds: [], emptyBlocks: [] };
  let y = top;
  let sourceBlockId = '';
  const push = (...items: DrawnItem[]): void => {
    page.items.push(...items);
    page.blockIds?.push(...items.map(() => sourceBlockId));
  };

  const newPage = (): void => {
    pages.push(page);
    page = { index: pages.length, items: [], blockIds: [], emptyBlocks: [] };
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
  const cursor: Parameters<typeof scaledFrame>[0] = {
    get y() { return y; },
    set y(value: number) { y = value; },
    x: REPORT_MARGIN,
    top,
    bottom,
    ensure,
    newPage,
    push,
    truncate: (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure),
  };

  // Both a full-width chart/image and one half of a two-up row need the same
  // box measured against different widths, so the size and position math is
  // computed once per block and the actual `y` (known only after a possible
  // page break) is applied last, through `draw`.
  const layoutImage = (block: Extract<ResolvedBlock, { kind: 'image' }>, boxX: number, boxW: number, pageH = size.h, layoutScale = 1): { height: number; draw: (y: number) => DrawnItem[] } => {
    // The caption's own row must fit the page frame too, so it is reserved before the image height
    // is clamped (review finding: a tall image + caption could still clamp to the full frame, then
    // draw the caption past `bottom`, in the footer band).
    const title = blockTitle(block);
    const titleH = title ? BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra : 0;
    const captionH = block.caption ? 14 : 0;
    if (pageFrame.authoredBands && titleH + captionH > printableHeight / layoutScale) throw new Error(labels('document.print.bandFrameTooShort'));
    const h = documentImageHeight(block, pageH, headingExtraHeight, pageFrame.authoredBands ? printableHeight / layoutScale : undefined);
    if (pageFrame.authoredBands && h <= 0) throw new Error(labels('document.print.bandFrameTooShort'));
    const w = Math.min(boxW, h * block.aspect);
    const drawnH = w / block.aspect;
    const x = block.align === 'left' ? boxX : block.align === 'right' ? boxX + boxW - w : boxX + (boxW - w) / 2;
    return {
      height: drawnH + captionH + titleH,
      draw: (y) => {
        const items: DrawnItem[] = title ? blockTitleItems(block, title, boxX, y, boxW, (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure)) : [];
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

  const layoutChart = (block: Extract<ResolvedBlock, { kind: 'chart' }>, boxX: number, boxW: number, pageH = size.h, layoutScale = 1): { height: number; draw: (y: number) => DrawnItem[] } => {
    const textScale = chartFontScale(block.fontSize);
    // A chart's heading defaults to its text size; an authored heading size overrides it (#6632).
    const heading = blockTitleStyle(block, BLOCK_TITLE_SIZE_DEFAULT * textScale);
    // The configured height (up to CHART_BLOCK_HEIGHT_MAX, 600pt) must still fit a single page next to its
    // title strip and, when stacked, its snapshot — otherwise the SVG is clipped past the footer (review finding).
    const { height: chartHeight, sideBySide, stacked, snapshotHeight, totalHeight: totalH } = documentChartLayout({
      headingExtraHeight,
      printableHeight: pageFrame.authoredBands ? printableHeight / layoutScale : undefined,
      requestedHeight: block.height ?? CHART_HEIGHT,
      pageHeight: pageH,
      boxWidth: boxW,
      snapshot: block.snapshot,
      hasData: block.hasData,
      fontSize: block.fontSize,
      layoutScale,
      titleExtraHeight: heading.extra,
    });
    if (pageFrame.authoredBands && (chartHeight <= 0 || (stacked && snapshotHeight <= 0) || totalH > printableHeight / layoutScale + 1e-6)) throw new Error(labels('document.print.bandFrameTooShort'));
    const chartW = sideBySide ? Math.round(boxW * 0.6) - BLOCK_GAP / 2 : boxW;
    return {
      height: totalH,
      draw: (y) => {
        // Give each line the column width. The old 80pt subtitle slot cut ordinary totals
        // such as "13 buckets · 12,623 elements" even on a full-width A4 chart (#4940).
        const subtitle = truncateToWidth(block.subtitle, boxW - CHART_TITLE_RESERVE, 8 * textScale, false, input.measure);
        const items: DrawnItem[] = [
          ...blockTitleItems(block, block.title, boxX, y, boxW, (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure), textScale, CHART_TITLE_RESERVE),
          { kind: 'text', x: boxX, y: y + 24 * textScale + heading.extra, size: 8 * textScale, bold: false, gray: 130, text: subtitle },
        ];
        const chartY = y + 32 * textScale + heading.extra;
        items.push({ kind: 'chart', blockId: block.id, x: boxX, y: chartY, w: chartW, h: chartHeight });
        if (sideBySide) items.push({ kind: 'snapshot', blockId: block.id, x: boxX + chartW + BLOCK_GAP, y: chartY, w: boxW - chartW - BLOCK_GAP, h: snapshotHeight });
        else if (stacked && snapshotHeight > 0) items.push({ kind: 'snapshot', blockId: block.id, x: boxX, y: chartY + chartHeight + BLOCK_GAP, w: boxW, h: snapshotHeight });
        return items;
      },
    };
  };

  const textLayout = (block: Extract<ResolvedBlock, { kind: 'text' }>, x: number, width: number) => layoutText(block, x, width, input.measure);
  // A block with a size factor (#6548) is laid out in a column `scale` times wider and a frame `scale`
  // times shorter, at its authored point sizes, and then drawn `scale` times larger: text and graphics
  // grow by one factor and the wrapping is what it would be at that size.
  const layoutPairable = (block: Extract<ResolvedBlock, { kind: 'text' | 'image' | 'chart' }>, boxX: number, boxW: number): { height: number; draw: (y: number) => DrawnItem[] } => {
    const scale = blockScale(block);
    const pageH = scaledPageHeight(size.h, headingExtraHeight, scale);
    const lay = (x: number, w: number) => block.kind === 'text' ? textLayout(block, x, w)
      : block.kind === 'chart' ? layoutChart(block, x, w, pageH, scale)
      : layoutImage(block, x, w, pageH, scale);
    if (scale === 1) return lay(boxX, boxW);
    const inner = lay(0, boxW / scale);
    return { height: inner.height * scale, draw: (y) => inner.draw(0).map((item) => zoomItem(item, scale, { x: (v) => boxX + v * scale, y: (v) => y + v * scale })) };
  };

  const frame = (scale: number) => scaledFrame(cursor, contentW, scale);

  const wrap = (text: string, width: number, size: number, bold: boolean) => wrapText(text, width, size, bold, input.measure);

  for (const [sectionIndex, blocks] of splitDocumentSections(input.blocks).entries()) {
    if (sectionIndex > 0 && (page.items.length > 0 || y > top)) newPage();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      sourceBlockId = block.id;
      const next = blocks[i + 1];
      if (next && isHalfPairable(block) && isHalfPairable(next)) {
        const colW = (contentW - BLOCK_GAP) / 2;
        const textFits = (candidate: typeof block): boolean => {
          if (candidate.kind !== 'text') return true;
          const scale = blockScale(candidate);
          return halfTextFitsPage(candidate, scaledPageHeight(size.h, headingExtraHeight, scale), colW / scale, headingExtraHeight, printableHeight / scale);
        };
        if (textFits(block) && textFits(next)) {
          const a = layoutPairable(block, REPORT_MARGIN, colW);
          const b = layoutPairable(next, REPORT_MARGIN + colW + BLOCK_GAP, colW);
          const rowH = Math.max(a.height, b.height);
          // An oversized text column falls back to the ordinary paginated text path.
          if (rowFitsFrame(rowH, bottom - top)) {
            ensure(rowH + BLOCK_GAP);
            push(...a.draw(y));
            sourceBlockId = next.id;
            push(...b.draw(y));
            y += rowH + BLOCK_GAP;
            i += 1;
            continue;
          }
        }
      }
      switch (block.kind) {
        case 'text': {
          const f = frame(blockScale(block));
          const { style, size, lineH, lines, rows, title, titleHeight } = textLayout(block, REPORT_MARGIN, f.w);
          if (!title && !block.backgroundColor && lines.every((l) => l.length === 0)) {
            page.emptyBlocks?.push({ blockId: block.id, x: REPORT_MARGIN, y, w: contentW, h: lineH * blockScale(block) });
            f.y += lineH;
            break;
          }
          if (title) {
            f.ensure(titleHeight + style.gapBefore + lineH * Math.min(lines.length, 2));
            f.push(...blockTitleItems(block, title, REPORT_MARGIN, f.y, f.w, (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure)));
            f.y += titleHeight;
          }
          f.y += style.gapBefore;
          // A heading is not left alone at the bottom of a page: the first two lines move together.
          f.ensure(lineH * Math.min(lines.length, 2));
          for (const row of rows) {
            const line = row.text;
            if (f.y + lineH > f.bottom) newPage();
            f.push(...textBackground(block, REPORT_MARGIN, f.y, f.w, lineH), { kind: 'text', x: REPORT_MARGIN, y: f.y + size, size, bold: style.bold, gray: style.gray, text: line, font: block.font, color: block.textColor, ...(row.bindingMarks?.length ? { bindingMarks: row.bindingMarks } : {}) });
            f.y += lineH;
          }
          y += BLOCK_GAP;
          break;
        }
        case 'spacer': {
          // A spacer taller than the printable page would otherwise push every following item past
          // the footer, since `ensure` only starts one fresh page (review finding).
          const height = Math.min(block.height, bottom - top);
          ensure(height);
          page.emptyBlocks?.push({ blockId: block.id, x: REPORT_MARGIN, y, w: contentW, h: height });
          y += height;
          break;
        }
        case 'image':
        case 'chart': {
          const single = layoutPairable(block, REPORT_MARGIN, contentW);
          ensure(single.height + BLOCK_GAP);
          push(...single.draw(y));
          y += single.height + BLOCK_GAP;
          break;
        }
        case 'table': {
          const scale = blockScale(block);
          layoutTable(block, frame(scale), contentW / scale, input.measure, BLOCK_GAP / scale, (text, width, size, bold) => wrapText(text, width, size, bold, input.measure));
          break;
        }
        case 'ids-report': {
          const scale = blockScale(block);
          const f = frame(scale);
          layoutIdsReport(block, f, contentW / scale, BLOCK_GAP / scale, wrap, (ring) => f.push(ring), labels);
          break;
        }
        case 'manual-report': {
          const scale = blockScale(block);
          const f = frame(scale);
          layoutManualReport(block, f, contentW / scale, BLOCK_GAP / scale, wrap, (ring) => { f.push(ring); }, labels);
          break;
        }
        case 'topic': {
          const f = frame(blockScale(block));
          const lineH = 10 * 1.4;
          const snapshotW = block.snapshotAspect ? Math.min(190, TOPIC_SNAPSHOT_HEIGHT * block.snapshotAspect) : 0;
          const snapshotH = block.snapshotAspect ? snapshotW / block.snapshotAspect : 0;
          const textW = f.w - (snapshotW ? snapshotW + BLOCK_GAP : 0);
          const lines = block.lines.flatMap((l) => wrapText(l, textW, 10, false, input.measure));
          // Title, snapshot and the first lines move together; a long description then continues page by page.
          const titleHeight = BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra;
          f.ensure(Math.max(titleHeight + Math.min(lines.length, 3) * lineH, snapshotH) + BLOCK_GAP);
          f.push(...blockTitleItems(block, block.title, REPORT_MARGIN, f.y, textW, (text, width, size, bold) => truncateToWidth(text, width, size, bold, input.measure)));
          if (block.snapshotAspect) f.push({ kind: 'topic-snapshot', blockId: block.id, x: REPORT_MARGIN + f.w - snapshotW, y: f.y, w: snapshotW, h: snapshotH });
          const snapshotBottom = f.y + snapshotH;
          let ty = f.y + titleHeight;
          for (const line of lines) {
            if (ty + lineH > f.bottom) {
              newPage();
              ty = f.y;
            }
            f.push({ kind: 'text', x: REPORT_MARGIN, y: ty + 10, size: 10, bold: false, gray: 60, text: line });
            ty += lineH;
          }
          f.y = Math.max(ty, page.items.some((i) => i.kind === 'topic-snapshot' && i.blockId === block.id) ? snapshotBottom : ty);
          y += BLOCK_GAP;
          break;
        }
      }
    }
  }
  pages.push(page);
  for (const body of pages) pageFrame.assertBody(body.items);

  return { page: input.page, size, pages, header: input.name, ...(pageHeading ? { pageHeading } : {}),
    footer: pageFrame.footer, pageFrames: pageFrame.pages(pages.length),
    pageCounters: pages.map(page => labels('document.print.pageCounter', { page: page.index + 1, total: pages.length })) };
}
