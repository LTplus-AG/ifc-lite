/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSV / JSON rendering for `ifc-lite schedule`.
 *
 * A schedule is a list of header names plus one raw value per (row, column).
 * CSV routes every cell through `escapeCsvCell` (RFC 4180 quoting + the
 * spreadsheet-formula-injection guard) shared with the `export` command; a
 * missing value renders as an empty CSV cell and as JSON `null`.
 */

import { escapeCsvCell } from '@ifc-lite/export';
import { columnValueToCsv } from './export.js';
import type { ScheduleColumn } from './schedule-columns.js';

/** One resolved row: the raw value for each column, in column order. */
export type ScheduleRow = unknown[];

/**
 * Render the schedule as RFC-4180 CSV. Headers and cells both go through the
 * shared escaper so a header or value containing a comma, quote, newline, or a
 * leading formula trigger is correctly quoted/neutralised.
 */
export function renderScheduleCsv(columns: ScheduleColumn[], rows: ScheduleRow[]): string {
  const sep = ',';
  const headerLine = columns.map(c => escapeCsvCell(c.header, { delimiter: sep })).join(sep);
  const dataLines = rows.map(row =>
    row.map(value => escapeCsvCell(columnValueToCsv(value), { delimiter: sep })).join(sep),
  );
  return [headerLine, ...dataLines].join('\n');
}

/**
 * Render the schedule as a JSON array of row objects keyed by header. Raw
 * values keep their type; a missing value is `null`.
 */
export function renderScheduleJson(columns: ScheduleColumn[], rows: ScheduleRow[]): Record<string, unknown>[] {
  return rows.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      const value = row[i];
      obj[col.header] = value == null ? null : value;
    });
    return obj;
  });
}
