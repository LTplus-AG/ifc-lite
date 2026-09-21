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
 * A table block's data as the preview and the PDF see it: the list is run
 * asynchronously (a pset-heavy list over a large federation takes seconds),
 * and a block whose run has not finished — or could not run — prints that
 * instead of stale or empty rows.
 */
export type TableState =
  | { status: 'resolving' }
  | { status: 'ok'; model: ExportModel }
  | { status: 'error'; message: string }
  | { status: 'no-model' };

/** Why a table block prints a message instead of rows; `null` when it has rows. Shared by the preview (i18n) and the PDF (English). */
export type TableMessageKind = 'resolving' | 'no-model' | 'error' | 'no-rows';

export function tableMessageKind(state: TableState | undefined): TableMessageKind | null {
  if (!state || state.status === 'resolving') return 'resolving';
  if (state.status === 'no-model') return 'no-model';
  if (state.status === 'error') return 'error';
  return state.model.totals.count === 0 ? 'no-rows' : null;
}

export interface TableRowOut {
  cells: string[];
  role: TableRowRole;
}

export interface TableColumnOut {
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
