/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Table-block layout constants and row math (#5138), split out of
 * `compose.ts` so a 2 000-row table's pagination does not push that file
 * over its module-size budget. `compose.ts`'s main loop still owns the
 * actual page-break decisions (the same "measure once, draw at the y a
 * possible page break settles on" shape it already uses for chart/image/
 * topic blocks) — this file only says how many rows fit in a given height,
 * so a row is never split across two chunks and the header repeats on each.
 */
import type { TableColumnId } from './types.js';

/** One printed row's height, in points: 8pt font (`generate-report-pdf.ts`'s
 *  bucket-table styles) at a ~1.15 line height plus 2pt top/bottom cell
 *  padding — jspdf-autotable's own minimum for that font size, so the
 *  estimate does not under-count how many rows a real page holds. */
export const TABLE_ROW_HEIGHT = 13.2;
export const TABLE_HEADER_HEIGHT = 15;
export const TABLE_TITLE_HEIGHT = 14;
export const TABLE_CAPTION_HEIGHT = 12;

export interface ResolvedTableBlock {
  kind: 'table';
  id: string;
  title?: string;
  caption?: string;
  columns: TableColumnId[];
  headers: string[];
  rows: string[][];
  truncated: boolean;
  /** Set when the report is absent or the block's `ruleId` no longer matches it (#5138); drawn as a message instead of an (empty) table. */
  placeholderMessage?: string;
}

/** How many body rows fit under one header in `availableHeight` points; always at least 1, so an oversized single row still advances instead of looping forever. */
export function tableRowsPerChunk(availableHeight: number): number {
  return Math.max(1, Math.floor((availableHeight - TABLE_HEADER_HEIGHT) / TABLE_ROW_HEIGHT));
}

/** The vertical space a chunk of `rowCount` rows (with its own header) occupies. */
export function tableChunkHeight(rowCount: number): number {
  return TABLE_HEADER_HEIGHT + rowCount * TABLE_ROW_HEIGHT;
}
