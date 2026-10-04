/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The heading every block kind draws (#6632): one place decides its size, ink and strip, so no composer re-derives them. */
import { BLOCK_TITLE_HEIGHT, BLOCK_TITLE_SIZE_DEFAULT, blockTitleStyle, type BlockHeaderStyleFields } from './block-title.js';
import type { TableDrawnItem } from './compose-table.js';

/** Inset between a heading strip's edge and its text, only when a background is drawn. */
export const BLOCK_TITLE_PAD = 3;

/** A chart heading's text stops this far short of its column edge, as its subtitle does. */
export const CHART_TITLE_RESERVE = 4;

/** Helvetica's cap height per point of size: centres a heading's capitals in its strip (#6705 F7). */
export const TITLE_CAP_HEIGHT = 0.718;

export type TruncateTitle = (text: string, width: number, size: number, bold: boolean) => string;

/**
 * The heading's items at `(x, y)` over `width`: an optional background strip (a `rect`, filled by the same `fillRect` as a text background), then the bold text
 * whose baseline sits one font size below `y`, or, on a strip, with its capitals centred in the strip. `unit` is 1 except for a chart, whose default heading
 * follows its text size. With no style set the output is exactly the 11pt black line every kind drew
 * before, with no extra keys. `reserve` is room kept free at the column's right edge for the text only:
 * the strip always spans `width`, so every kind's strip has the same edges.
 */
export function blockTitleItems(block: BlockHeaderStyleFields, text: string, x: number, y: number, width: number, truncate: TruncateTitle, unit = 1, reserve = 0): TableDrawnItem[] {
  const style = blockTitleStyle(block, BLOCK_TITLE_SIZE_DEFAULT * unit);
  const pad = style.backgroundColor ? BLOCK_TITLE_PAD : 0;
  const stripH = BLOCK_TITLE_HEIGHT * unit + style.extra;
  // On a strip the capitals are centred in it; without one the baseline stays where it always was.
  const baseline = style.backgroundColor ? y + (stripH + TITLE_CAP_HEIGHT * style.size) / 2 : y + style.size;
  return [
    ...(style.backgroundColor ? [{ kind: 'rect' as const, x, y, w: width, h: stripH, color: style.backgroundColor }] : []),
    { kind: 'text', x: x + pad, y: baseline, size: style.size, bold: true, gray: 0, text: truncate(text, width - reserve - 2 * pad, style.size, true), ...(style.textColor ? { color: style.textColor } : {}) },
  ];
}
