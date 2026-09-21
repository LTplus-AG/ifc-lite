/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Laying out a table block (#5142) on the document's page model: title
 * strip, then the rows in page-sized chunks — each chunk carries the head,
 * so the head repeats on every page — then the caption. Pure like
 * `compose.ts`; the PDF draws each chunk with one autotable call and the
 * chunk is guaranteed to fit, so autotable never paginates on its own.
 *
 * Column widths are computed once per block over every printed row and
 * reused by every chunk, so the columns line up across pages.
 */
import type { TableColumnOut, TableRowOut } from './resolve-table.js';

/** 11pt bold title at `y + 11`, the same strip a chart block gets. */
export const TABLE_TITLE_HEIGHT = 18;
/**
 * Head and body row height: jspdf-autotable's minimum row for `fontSize 8`
 * (8 × its 1.15 line factor = 9.2) plus `cellPadding 2` top and bottom.
 * The browser seam pins `minCellHeight` to the same number, so the
 * composer's arithmetic and autotable's agree.
 */
export const TABLE_ROW_HEIGHT = 13.2;
export const TABLE_FONT_SIZE = 8;
const CAPTION_HEIGHT = 14;
const MESSAGE_HEIGHT = 14;
/** Cell padding (2 each side) plus a little slack over the measured text. */
const CELL_SLACK = 6;
const MIN_COLUMN_WIDTH = 28;

export type Measure = (text: string, size: number, bold: boolean) => number;

export interface TableColumnLayout {
  label: string;
  width: number;
  align: 'left' | 'right';
}

/** What the composer needs of a resolved table block. */
export interface TableLayoutBlock {
  id: string;
  title: string;
  caption?: string;
  /** Printed instead of the table: nothing to print, still resolving, or an error. */
  message?: string;
  columns: TableColumnOut[];
  rows: TableRowOut[];
}

/** A line of text on the page; `compose.ts` draws the same shape for every block. */
export interface TextDrawnItem { kind: 'text'; x: number; y: number; size: number; bold: boolean; gray: number; text: string }

export type TableDrawnItem =
  | TextDrawnItem
  | { kind: 'table'; blockId: string; x: number; y: number; w: number; columns: TableColumnLayout[]; rows: TableRowOut[] };

/** The page cursor `composeDocument` lays blocks out with; `y` is the running position. */
export interface LayoutCursor {
  y: number;
  /** Left edge of the content frame (the page margin). */
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
  /** Start a new page unless `h` fits below `y` (or the page is still empty). */
  ensure(h: number): void;
  newPage(): void;
  push(...items: TableDrawnItem[]): void;
  /** A single line ellipsis-truncated to `width`. */
  truncate(text: string, width: number, size: number, bold: boolean): string;
}

/**
 * Widths in points, summing exactly `contentW`: each column's natural width
 * (its widest of label or cell, plus padding) clamped to [28, contentW/2],
 * then scaled proportionally to fill the frame — or to fit it, letting
 * autotable's `ellipsize` cut cells that no longer fit.
 */
export function tableColumnWidths(columns: readonly TableColumnOut[], rows: readonly TableRowOut[], contentW: number, measure: Measure): number[] {
  if (columns.length === 0) return [];
  const natural = columns.map((c, i) => {
    let widest = measure(c.label, TABLE_FONT_SIZE, true);
    for (const row of rows) {
      const cell = row.cells[i];
      if (cell) widest = Math.max(widest, measure(cell, TABLE_FONT_SIZE, false));
    }
    return Math.min(Math.max(widest + CELL_SLACK, MIN_COLUMN_WIDTH), contentW / 2);
  });
  const sum = natural.reduce((a, b) => a + b, 0);
  const scale = contentW / sum;
  const widths = natural.map((w) => w * scale);
  // Rounding drift lands on the last column so the sum is exact.
  const drift = contentW - widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += drift;
  return widths;
}

export function layoutTable(block: TableLayoutBlock, cursor: LayoutCursor, contentW: number, measure: Measure, blockGap: number): void {
  const head = TABLE_ROW_HEIGHT;
  const row = TABLE_ROW_HEIGHT;
  const rows = block.rows;

  // Title, head and the first rows move together (a heading keeps its next line the same way).
  // `message` decides by presence, not truthiness: an empty error message still prints as a message line (review finding).
  const hasMessage = block.message !== undefined;
  const lead = TABLE_TITLE_HEIGHT + (hasMessage ? MESSAGE_HEIGHT : head + Math.min(3, rows.length) * row);
  cursor.ensure(lead);
  cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 11, size: 11, bold: true, gray: 0, text: cursor.truncate(block.title, contentW, 11, true) });
  cursor.y += TABLE_TITLE_HEIGHT;

  if (hasMessage) {
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 10, size: 10, bold: false, gray: 130, text: cursor.truncate(block.message ?? '', contentW, 10, false) });
    cursor.y += MESSAGE_HEIGHT;
  } else {
    const widths = tableColumnWidths(block.columns, rows, contentW, measure);
    const columns: TableColumnLayout[] = block.columns.map((c, i) => ({ label: c.label, width: widths[i], align: c.numeric ? 'right' : 'left' }));
    let i = 0;
    do {
      const room = Math.floor((cursor.bottom - cursor.y - head) / row);
      if (room < 1 && cursor.y > cursor.top) {
        cursor.newPage();
        continue;
      }
      let n = Math.min(Math.max(room, 1), rows.length - i);
      // A group header is never the last row of a page: it moves to the next chunk with its rows.
      if (n > 1 && i + n < rows.length && rows[i + n - 1].role === 'group') n -= 1;
      cursor.push({ kind: 'table', blockId: block.id, x: cursor.x, y: cursor.y, w: contentW, columns, rows: rows.slice(i, i + n) });
      cursor.y += head + n * row;
      i += n;
      if (i < rows.length) cursor.newPage();
    } while (i < rows.length);
  }

  if (block.caption) {
    if (cursor.y + CAPTION_HEIGHT > cursor.bottom) cursor.newPage();
    cursor.push({ kind: 'text', x: cursor.x, y: cursor.y + 11, size: 8, bold: false, gray: 130, text: cursor.truncate(block.caption, contentW, 8, false) });
    cursor.y += CAPTION_HEIGHT;
  }
  cursor.y += blockGap;
}
