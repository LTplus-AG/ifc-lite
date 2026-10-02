/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical text measurement, wrapping and layout for document preview/PDF. */
import type { ComposeDocumentInput, DrawnItem } from './compose.js';
import type { TextBlock, TextFont } from './types.js';
import { wrapTextRows } from './compose-text-wrap.js';
import type { ResolvedBindingSpan } from './bindings.js';
import { blockTitle, BLOCK_TITLE_HEIGHT } from './block-title.js';

export const TEXT_STYLES: Record<TextBlock['style'], { size: number; bold: boolean; lineHeight: number; gapBefore: number; gray: number }> = {
  title: { size: 20, bold: true, lineHeight: 1.3, gapBefore: 6, gray: 0 },
  heading: { size: 13, bold: true, lineHeight: 1.35, gapBefore: 8, gray: 0 },
  subheading: { size: 11, bold: true, lineHeight: 1.3, gapBefore: 6, gray: 0 },
  body: { size: 10, bold: false, lineHeight: 1.4, gapBefore: 0, gray: 0 },
  small: { size: 8.5, bold: false, lineHeight: 1.35, gapBefore: 0, gray: 0 },
  // Matches the image-caption text below (size 8, gray 130).
  caption: { size: 8, bold: false, lineHeight: 1.3, gapBefore: 2, gray: 130 },
};

/**
 * Greedy word wrap on the measure; a word longer than the line is broken by characters.
 * Whitespace is kept as typed, like the preview's `white-space: pre-wrap` (#6370): a `\n`
 * starts a new line, a tab becomes spaces to the next tab stop, and a run of spaces
 * inside a line stays a run. Only the whitespace at a wrap point is dropped.
 */
export function wrapText(text: string, width: number, size: number, bold: boolean, measure: ComposeDocumentInput['measure'], font?: TextFont): string[] {
  return wrapTextRows(text, width, size, bold, measure, font).map(row => row.text);
}

/** A single line, ellipsis-truncated to fit `width` by the same measure `wrapText` uses (#4940 review: a half-width chart's title/subtitle must not run into the next column). */
export function truncateToWidth(text: string, width: number, size: number, bold: boolean, measure: ComposeDocumentInput['measure']): string {
  if (width <= 0 || measure(text, size, bold) <= width) return text;
  // Binary, not linear: a linear cut-by-one scan remeasures a near-full string once per code
  // unit, quadratic in an imported title's length (review finding). `measure` grows monotonically
  // with the prefix length for both measures this module is called with (jsPDF's textWidth, the
  // character-count estimate), so the longest prefix that still fits is found by bisection.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const cut = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, cut)}…`, size, bold) <= width) low = cut;
    else high = cut - 1;
  }
  return low > 0 ? `${text.slice(0, low)}…` : '…';
}

export const textBackground = (block: TextBlock, x: number, y: number, w: number, h: number): DrawnItem[] =>
  block.backgroundColor ? [{ kind: 'text-background', x, y, w, h, color: block.backgroundColor }] : [];

export function layoutText(block: TextBlock & { bindingSpans?: ResolvedBindingSpan[] }, boxX: number, boxW: number, measure: ComposeDocumentInput['measure']) {
  const style = TEXT_STYLES[block.style];
  const size = block.fontSize ?? style.size;
  const lineH = size * style.lineHeight;
  const rows = wrapTextRows(block.text, boxW, size, style.bold, measure, block.font, block.bindingSpans);
  const lines = rows.map(row => row.text);
  const title = blockTitle(block);
  const titleHeight = title ? BLOCK_TITLE_HEIGHT : 0;
  return { style, size, lineH, lines, rows, title, titleHeight, height: titleHeight + style.gapBefore + lines.length * lineH,
    draw: (atY: number): DrawnItem[] => [
      ...(title ? [{ kind: 'text' as const, x: boxX, y: atY + 11, size: 11, bold: true, gray: 0, text: truncateToWidth(title, boxW, 11, true, measure) }] : []),
      ...textBackground(block, boxX, atY + titleHeight + style.gapBefore, boxW, lines.length * lineH),
      ...rows.map<DrawnItem>((row, index) => ({ kind: 'text', x: boxX, y: atY + titleHeight + style.gapBefore + index * lineH + size, size, bold: style.bold, gray: style.gray, text: row.text, font: block.font, color: block.textColor, ...(row.bindingMarks?.length ? { bindingMarks: row.bindingMarks } : {}) })),
    ],
  };
}
