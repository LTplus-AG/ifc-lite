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
import type { SubtotalPlan, SubtotalRowData } from './schedule-aggregate.js';

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
  return rows.map(row => scheduleRowToJson(columns, row));
}

/** One data row as a header-keyed object; a missing value is `null`. */
function scheduleRowToJson(columns: ScheduleColumn[], row: ScheduleRow): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  columns.forEach((col, i) => {
    const value = row[i];
    obj[col.header] = value == null ? null : value;
  });
  return obj;
}

/**
 * The subtotal/total label for a group: `Subtotal (H1=v1, H2=v2)` or `Total`,
 * suffixed with `: <n>` when a `count` aggregation is present (the row count of
 * the group / whole schedule).
 */
function subtotalLabel(data: SubtotalRowData): string {
  const base = data.kind === 'total'
    ? 'Total'
    : `Subtotal (${data.groupValues.map(g => `${g.header}=${g.value == null ? '' : String(g.value)}`).join(', ')})`;
  const count = data.values.find(v => v.spec === 'count');
  return count ? `${base}: ${count.value}` : base;
}

/**
 * A subtotal/total row as a full-width cell array. The label sits in the first
 * group column (column 0 for the grand total); each numeric aggregation fills
 * its target column; every other column is blank.
 */
function subtotalCells(columns: ScheduleColumn[], data: SubtotalRowData): unknown[] {
  const cells: unknown[] = columns.map(() => '');
  const labelCol = data.groupValues.length > 0 ? data.groupValues[0].index : 0;
  cells[labelCol] = subtotalLabel(data);
  for (const v of data.values) {
    if (v.spec === 'count') continue;
    const header = v.spec.slice(v.spec.indexOf(':') + 1);
    const idx = columns.findIndex(c => c.header === header);
    if (idx === -1 || idx === labelCol) continue; // label column keeps the label
    cells[idx] = v.value == null ? '' : v.value;
  }
  return cells;
}

/**
 * Render a schedule with `--subtotals`. Grouped output emits each contiguous
 * group's rows followed by its subtotal row; the grand total closes the table.
 * Without `--group-by` only the flat rows and the grand total are emitted.
 */
export function renderScheduleCsvWithSubtotals(columns: ScheduleColumn[], plan: SubtotalPlan): string {
  const sep = ',';
  const escapeRow = (row: unknown[]): string =>
    row.map(value => escapeCsvCell(columnValueToCsv(value), { delimiter: sep })).join(sep);

  const lines = [columns.map(c => escapeCsvCell(c.header, { delimiter: sep })).join(sep)];
  if (plan.groups.length > 0) {
    for (const group of plan.groups) {
      for (const row of group.rows) lines.push(escapeRow(row));
      lines.push(escapeRow(subtotalCells(columns, group.subtotal)));
    }
  } else {
    for (const row of plan.rows) lines.push(escapeRow(row));
  }
  lines.push(escapeRow(subtotalCells(columns, plan.total)));
  return lines.join('\n');
}

/** The JSON form of a subtotal/total row: `__row` marker + group + aggregated fields. */
function subtotalToJson(data: SubtotalRowData): Record<string, unknown> {
  const obj: Record<string, unknown> = { __row: data.kind };
  for (const g of data.groupValues) obj[g.header] = g.value == null ? null : g.value;
  for (const v of data.values) obj[v.spec] = v.value;
  return obj;
}

/** Render a schedule with `--subtotals` as flat JSON rows plus `__row`-marked subtotal/total objects. */
export function renderScheduleJsonWithSubtotals(columns: ScheduleColumn[], plan: SubtotalPlan): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (plan.groups.length > 0) {
    for (const group of plan.groups) {
      for (const row of group.rows) out.push(scheduleRowToJson(columns, row));
      out.push(subtotalToJson(group.subtotal));
    }
  } else {
    for (const row of plan.rows) out.push(scheduleRowToJson(columns, row));
  }
  out.push(subtotalToJson(plan.total));
  return out;
}
