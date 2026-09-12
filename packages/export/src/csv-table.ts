/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RFC 4180 CSV for a table of row OBJECTS — one header row from `columns`, then
 * one line per row reading exactly those keys, in that order.
 *
 * Every table export in this repo (zones, clashes, …) had grown its own copy of
 * the same 15-line loop around `escapeCsvCell`. The loop is not where the
 * security lives — that is the escaper — but three copies of "null → empty,
 * boolean → `true`/`false`, trailing newline" still drift (one forgot the
 * trailing newline, so `cat a.csv b.csv` joined two rows). One writer, one set
 * of rules:
 *
 * - `null` / `undefined` → empty cell (a spreadsheet reads `null` as text).
 * - booleans → `true` / `false` (not `1`/`0`, which sum).
 * - every other value → `String(value)` through {@link escapeCsvCell}, which
 *   applies RFC 4180 quoting and the CWE-1236 formula-injection guard. A cell
 *   whose first or last character is whitespace is quoted so an importer cannot
 *   trim the padding away (`quoteWhitespacePadded`).
 * - lines end with `\n` and the file ends with one.
 */
import { escapeCsvCell } from './csv-cell.js';

export interface TableToCsvOptions {
  /** Column delimiter; defaults to `,`. */
  delimiter?: string;
}

/** A column key naming a property of every row. */
export type TableColumn<Row> = Extract<keyof Row, string>;

/** Serialise one cell value under the rules documented on {@link tableToCsv}. */
export function csvCellOf(value: unknown, delimiter = ','): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return escapeCsvCell(raw, { delimiter, quoteWhitespacePadded: true });
}

export function tableToCsv<Row extends object>(
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
  options: TableToCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const lines = [columns.map((column) => csvCellOf(column, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCellOf(row[column], delimiter)).join(delimiter));
  }
  return `${lines.join('\n')}\n`;
}
