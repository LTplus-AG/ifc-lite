/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical text measurement, wrapping and layout for document preview/PDF. */
import type { ComposeDocumentInput, DrawnItem } from './compose.js';
import type { TextBlock, TextFont } from './types.js';
import { tabFill } from './text-tabs.js';
import { blockTitle, blockTitleStyle, BLOCK_TITLE_HEIGHT } from './block-title.js';
import { blockTitleItems } from './compose-block-title.js';

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
  const lines: string[] = [];
  const fits = (line: string): boolean => measure(line, size, bold, font) <= width;
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!/\S/.test(paragraph)) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const token of paragraph.match(/\t|[^\S\t]+|\S+/g) ?? []) {
      // Whitespace never wraps by itself: at a wrap point it hangs and is dropped (below), as in
      // `pre-wrap`. A tab measures from the start of the line it lands on, after any wrap.
      if (token === '\t') { line += tabFill(line, (t) => measure(t, size, bold, font)); continue; }
      if (/^\s/.test(token) || fits(line + token)) {
        line += token;
        continue;
      }
      const kept = line.trimEnd();
      if (kept) lines.push(kept);
      line = token;
      while (!fits(line) && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && !fits(line.slice(0, cut))) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
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

export function layoutText(block: TextBlock, boxX: number, boxW: number, measure: ComposeDocumentInput['measure']) {
  const style = TEXT_STYLES[block.style];
  const size = block.fontSize ?? style.size;
  const lineH = size * style.lineHeight;
  const lines = wrapText(block.text, boxW, size, style.bold, measure, block.font);
  const title = blockTitle(block);
  const titleHeight = title ? BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra : 0;
  return { style, size, lineH, lines, title, titleHeight, height: titleHeight + style.gapBefore + lines.length * lineH,
    draw: (atY: number): DrawnItem[] => [
      ...(title ? blockTitleItems(block, title, boxX, atY, boxW, (text, width, size, bold) => truncateToWidth(text, width, size, bold, measure)) : []),
      ...textBackground(block, boxX, atY + titleHeight + style.gapBefore, boxW, lines.length * lineH),
      ...lines.map<DrawnItem>((line, index) => ({ kind: 'text', x: boxX, y: atY + titleHeight + style.gapBefore + index * lineH + size, size, bold: style.bold, gray: style.gray, text: line, font: block.font, color: block.textColor })),
    ],
  };
}
