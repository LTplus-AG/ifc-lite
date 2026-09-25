/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE `exceljs` read/write module for a flow `Table` (issue #5167
 * phase 3.2, §4a: "new exceljs read, shared module"). `apps/viewer` and
 * `packages/cli` both already depend on `@ifc-lite/flow-nodes` (the CLI to
 * run flow graphs headlessly, the viewer to power its flow editor), so this
 * is the shared home rather than a copy in each app.
 *
 * Pure data in, pure data out — no file-system or DOM access — so it runs
 * identically in the browser and headlessly. `WriteXlsx` guards every string
 * cell with `guardSpreadsheetFormula` (CWE-1236): unlike CSV, an `.xlsx`
 * writer has no quoting step of its own to lean on, but the trigger
 * characters (`=+-@`) are read by Excel/LibreOffice the same way regardless
 * of container, so the same guard applies (see that function's doc for why
 * it — not `escapeCsvCell` — is the one XLSX wants).
 */

import ExcelJS from 'exceljs';
import { guardSpreadsheetFormula } from '@ifc-lite/export';
import { PARSE_INVALID, parseValue } from '@ifc-lite/mutations';
import { COLUMN_TYPES, type Cell, type Column, type ColumnType, type Table } from '@ifc-lite/flow';
import { VALUE_TYPE_BY_COLUMN_TYPE } from './table-nodes.js';

export interface XlsxColumnSpec {
  readonly name: string;
  readonly type?: string;
}

export interface ReadXlsxOptions {
  /** Sheet name; defaults to the first (only) worksheet. */
  readonly sheet?: string;
  /** Optional column types; defaults to the header row, all `string`. */
  readonly columns?: readonly XlsxColumnSpec[];
  readonly key?: string;
}

export interface ReadXlsxResult {
  readonly table: Table;
  readonly problems: readonly string[];
}

function columnType(spec: XlsxColumnSpec | undefined): ColumnType {
  const t = spec?.type;
  return typeof t === 'string' && (COLUMN_TYPES as readonly string[]).includes(t) ? (t as ColumnType) : 'string';
}

/** A cell that has no usable text: an Excel error or a kind this reader cannot read. */
class UnreadableCell extends Error {}

/**
 * A worksheet cell's value as plain text for typed re-parsing. ExcelJS hands
 * back objects for several cell kinds, and every one is handled explicitly:
 * falling through to `String(v)` produced `"[object Object]"`, which a string
 * column accepted and `model.applyTable` then wrote (#5377 review).
 * - rich text `{ richText: [{ text }] }` → the runs joined (partially
 *   formatted text is ordinary in mapping sheets);
 * - a formula `{ formula, result }` → its cached result, itself read again;
 * - a hyperlink `{ text, hyperlink }` → its text;
 * - an error `{ error: '#N/A' }`, or any other object → UnreadableCell, so
 *   the caller reports the cell instead of writing garbage.
 */
function cellText(v: ExcelJS.CellValue | unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return String(v);
  const cell = v as Record<string, unknown>;
  if (Array.isArray(cell.richText)) {
    return (cell.richText as Array<{ text?: unknown }>).map((run) => String(run.text ?? '')).join('');
  }
  if ('error' in cell) throw new UnreadableCell(`spreadsheet error ${String(cell.error)}`);
  if ('result' in cell) return cellText(cell.result);
  if ('text' in cell && typeof cell.text !== 'object') return String(cell.text ?? '');
  throw new UnreadableCell('a cell kind this reader cannot read');
}

/** Read one worksheet into a typed `Table`. Row 1 is the header; a row whose
 *  cell count does not match the header is still read and reported, never
 *  dropped (same contract as `table.readCsv`). */
export async function readXlsxTable(data: Uint8Array, options: ReadXlsxOptions = {}): Promise<ReadXlsxResult> {
  const wb = new ExcelJS.Workbook();
  // `Workbook.xlsx.load`'s declared param type is Node's `Buffer`, which this
  // package's tsconfig does not pull in (it must typecheck for the browser
  // too); ExcelJS accepts a plain `Uint8Array`/`ArrayBuffer` at runtime — the
  // viewer's own xlsx export already relies on that (apps/viewer's
  // `lib/lists/export/xlsx.ts`). The cast goes through the library's own
  // declared param type rather than naming `Buffer`, so it stays correct if
  // that type ever changes shape.
  await wb.xlsx.load(data as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = options.sheet ? wb.getWorksheet(options.sheet) : wb.worksheets[0];
  if (!ws) throw new Error(options.sheet ? `xlsx has no sheet "${options.sheet}"` : 'xlsx has no worksheets');

  const headerRow = ws.getRow(1);
  const header: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    try {
      header.push(cellText(cell.value));
    } catch (error) {
      throw new Error(`header column ${colNumber}: ${(error as Error).message}`);
    }
  });
  const declared = options.columns;
  const names = declared && declared.length > 0 ? declared.map((c) => c.name) : header;
  const columns: Column[] = names.map((name, idx) => ({ name, type: columnType(declared?.[idx]) }));

  const problems: string[] = [];
  const rows: Record<string, Cell>[] = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const excelRow = ws.getRow(r);
    if (excelRow.cellCount === 0) continue;
    const cellsInRow: Array<string | UnreadableCell> = [];
    for (let c = 1; c <= header.length; c += 1) {
      try {
        cellsInRow.push(cellText(excelRow.getCell(c).value));
      } catch (error) {
        if (!(error instanceof UnreadableCell)) throw error;
        cellsInRow.push(error);
      }
    }
    let widest = 0;
    excelRow.eachCell({ includeEmpty: false }, (_cell, colNumber) => { widest = Math.max(widest, colNumber); });
    if (widest > header.length) problems.push(`row ${r}: expected ${header.length} column(s), got ${widest}`);

    const row: Record<string, Cell> = {};
    columns.forEach((col, idx) => {
      const raw = cellsInRow[idx] ?? '';
      if (raw instanceof UnreadableCell) {
        problems.push(`row ${r}: column "${col.name}": ${raw.message}`);
        row[col.name] = null;
        return;
      }
      if (raw === '') {
        row[col.name] = null;
        return;
      }
      if (col.type === 'string' || col.type === 'label' || col.type === 'identifier' || col.type === 'text' || col.type === 'enum' || col.type === 'reference') {
        row[col.name] = raw;
        return;
      }
      const parsed = parseValue(raw, VALUE_TYPE_BY_COLUMN_TYPE[col.type]);
      if (parsed === PARSE_INVALID) {
        problems.push(`row ${r}: column "${col.name}": cannot parse "${raw}" as ${col.type}`);
        row[col.name] = null;
        return;
      }
      row[col.name] = Array.isArray(parsed) ? parsed.join(';') : parsed;
    });
    rows.push(row);
  }

  const key = options.key && columns.some((c) => c.name === options.key) ? options.key : columns.some((c) => c.name === 'GlobalId') ? 'GlobalId' : (columns[0]?.name ?? 'GlobalId');
  return { table: { columns, rows, key }, problems };
}

/** Write a `Table` to a flat, single-sheet `.xlsx` workbook: one header row,
 *  one row per table row, columns in table order. */
export async function writeXlsxTable(table: Table, sheetName = 'Sheet1'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sheet1');
  ws.addRow(table.columns.map((c) => guardSpreadsheetFormula(c.name)));
  for (const row of table.rows) {
    ws.addRow(table.columns.map((c) => {
      const v = row[c.name];
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return guardSpreadsheetFormula(String(v));
    }));
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
