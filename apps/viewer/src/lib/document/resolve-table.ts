/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A list's `ExportModel` flattened into the rows a table block prints
 * (#5142): the same presentation the list's own CSV/XLSX/PDF writers
 * produce — schedule/pivot rows when the list says so, otherwise group
 * header rows (label, count, sums) in pre-order with their leaf rows, and a
 * grand-total row when anything is summed — cut to `maxRows` data rows
 * with a trailing "… n more rows" line. Pure: no store, no i18n (the
 * labels come in from the caller).
 */
import type { CellValue } from '@ifc-lite/lists';
import { displayCell, groupHeaderLabel, totalsRowCells, type ExportModel } from '../lists/export/model.js';

export type TableRowRole = 'row' | 'group' | 'total' | 'more';

/**
 * A pre-flatten table body any non-list source can produce (#5138): already
 * flat rows (no grouping/schedule concept), so turning it into a
 * `FlattenedTable` is just the row cap and "… n more" line a list's own flat
 * rows already get — see `flattenRawModel`.
 */
export interface RawTableModel {
  columns: TableColumnOut[];
  /** Every matching row, uncapped; role is always `'row'`. */
  rows: TableRowOut[];
  totalRows: number;
}

/** `flattenExportModel`'s cap + "… n more" tail, for a source that is already flat (#5138) — no groups, no schedule, no totals row. */
export function flattenRawModel(model: RawTableModel, maxRows: number, labels: TableLabels): FlattenedTable {
  const cap = Math.max(1, Math.floor(maxRows));
  const rows = model.rows.slice(0, cap);
  const more = Math.max(0, model.totalRows - rows.length);
  if (more > 0) rows.push({ cells: model.columns.map((_, i) => (i === 0 ? labels.more(more) : '')), role: 'more' });
  return { columns: model.columns, rows, more, totalRows: model.totalRows };
}

/**
 * A table block's data as the preview and the PDF see it: a list run is
 * asynchronous (a pset-heavy list over a large federation takes seconds)
 * and prints "resolving" until it settles; a validation-results table (#5138)
 * resolves synchronously from the store's report, so it never has a
 * `'resolving'` state of its own — only `'ok'`, or one of the two states
 * that are specific to it (`'no-report'`, `'rule-not-found'`). The two `'ok'`
 * members share the `status` so every existing list-only check (`state.status
 * === 'ok'`) still narrows the way it always did; `kind` (present only on
 * the validation member) is the second discriminant a consumer that must
 * tell them apart switches on.
 */
export type TableState =
  | { status: 'resolving' }
  | { status: 'ok'; kind?: 'list'; model: ExportModel }
  | { status: 'ok'; kind: 'validation'; model: RawTableModel }
  | { status: 'error'; message: string }
  | { status: 'no-model' }
  | { status: 'no-report' }
  | { status: 'rule-not-found' };

/** Why a table block prints a message instead of rows; `null` when it has rows. Shared by the preview (i18n) and the PDF (English). */
export type TableMessageKind = 'resolving' | 'no-model' | 'error' | 'no-rows' | 'no-report' | 'rule-not-found';

export function tableMessageKind(state: TableState | undefined): TableMessageKind | null {
  if (!state || state.status === 'resolving') return 'resolving';
  if (state.status !== 'ok') return state.status;
  const count = state.kind === 'validation' ? state.model.totalRows : state.model.totals.count;
  return count === 0 ? 'no-rows' : null;
}

export interface TableRowOut {
  cells: string[];
  role: TableRowRole;
}

export interface TableColumnOut {
  /** Set only for a source whose columns are a fixed, known set (#5138: validation's `TableColumnId`)
   *  rather than free-form user-authored labels (a list's own column names) — lets a consumer
   *  translate the header instead of printing `label` (English) verbatim. */
  id?: string;
  label: string;
  numeric: boolean;
}

export interface FlattenedTable {
  columns: TableColumnOut[];
  rows: TableRowOut[];
  /** Data rows not printed because of `maxRows`. */
  more: number;
  /** Data rows in the model, printed or not. */
  totalRows: number;
}

export interface TableLabels {
  more: (n: number) => string;
  total: (count: number) => string;
}

/** One line per cell: a value with a line break (`\X\0D\X\0A\` in a Revit comment) would otherwise make autotable draw a taller row than the composer counted (review finding). */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ');

export function flattenExportModel(model: ExportModel, maxRows: number, labels: TableLabels): FlattenedTable {
  const cap = Math.max(1, Math.floor(maxRows));
  const cols = model.schedule?.columns ?? model.columns;
  const columns: TableColumnOut[] = cols.map((c) => ({ label: oneLine(c.label), numeric: c.numeric }));
  const cells = (values: CellValue[]): string[] => cols.map((_, i) => oneLine(displayCell(values[i])));
  const rows: TableRowOut[] = [];
  let printed = 0;
  let totalRows = 0;

  if (model.schedule) {
    totalRows = model.schedule.rows.length;
    for (const r of model.schedule.rows) {
      if (printed >= cap) break;
      rows.push({ cells: cells(r), role: 'row' });
      printed += 1;
    }
  } else if (model.groups) {
    totalRows = model.totals.count;
    // A parent group's header prints even when its leaves are all cut, so the reader sees the
    // structure the "… n more" line stands for; but nothing prints past the cap except headers
    // of groups that already started.
    for (const g of model.groups) {
      if (printed >= cap) break;
      rows.push({
        cells: model.columns.map((c, i) => (i === 0 ? oneLine(groupHeaderLabel(g, '  ')) : c.summed ? displayCell(g.sums[c.id]) : '')),
        role: 'group',
      });
      for (const r of g.rows) {
        if (printed >= cap) break;
        rows.push({ cells: cells(r), role: 'row' });
        printed += 1;
      }
    }
  } else {
    totalRows = model.rows.length;
    for (const r of model.rows) {
      if (printed >= cap) break;
      rows.push({ cells: cells(r), role: 'row' });
      printed += 1;
    }
  }

  const more = Math.max(0, totalRows - printed);
  if (more > 0) rows.push({ cells: columns.map((_, i) => (i === 0 ? labels.more(more) : '')), role: 'more' });

  // Same rule as the list PDF's foot: a totals row only when something is summed.
  if (model.sumColumnIds.length > 0) {
    rows.push({ cells: totalsRowCells(model, cols, labels.total(model.totals.count)).map(displayCell), role: 'total' });
  }

  return { columns, rows, more, totalRows };
}
