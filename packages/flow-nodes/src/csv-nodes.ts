/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `table.readCsv` / `table.writeCsv` — the pilot workflow's spreadsheet
 * connector (issue #5167 phase 3.2): a mapping spreadsheet in, typed
 * `Table` rows out, and back.
 *
 * Reading is `csv-parse.ts`'s own RFC 4180 parser (there is no existing
 * reusable one — `CsvConnector`'s is private). Writing goes through
 * `@ifc-lite/export`'s `tableToCsv`, which is itself built on the ONE
 * canonical CWE-1236 escaper (`escapeCsvCell`) — this module never touches
 * formula-injection guarding directly, so `scripts/check-csv-escaper-copies.mjs`
 * has nothing new to find here.
 */

import { tableToCsv } from '@ifc-lite/export';
import { PARSE_INVALID } from '@ifc-lite/mutations';
import { parseStrictCell } from './strict-cell.js';
import type { Cell, Column, ColumnType, Table } from '@ifc-lite/flow';
import { COLUMN_TYPES } from '@ifc-lite/flow';
import { SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, type FlowNodeDef } from './host.js';
import { tableOf } from './table-nodes.js';
import { parseCsvText } from './csv-parse.js';

interface ColumnSpec {
  readonly name: string;
  readonly type?: string;
}

function isColumnSpec(v: unknown): v is ColumnSpec {
  return !!v && typeof v === 'object' && typeof (v as ColumnSpec).name === 'string';
}

/** Declared columns from the `columns` param, or `undefined` to infer
 *  (every header cell becomes a `string` column). */
function specColumns(raw: unknown): ColumnSpec[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const specs = raw.filter(isColumnSpec);
  return specs.length > 0 ? specs : undefined;
}

function columnType(spec: ColumnSpec | undefined): ColumnType {
  const t = spec?.type;
  return typeof t === 'string' && (COLUMN_TYPES as readonly string[]).includes(t) ? (t as ColumnType) : 'string';
}

export const csvNodes: FlowNodeDef[] = [
  {
    type: 'table.readCsv',
    title: 'Read CSV',
    category: 'table',
    doc: 'Parses CSV text into a typed table. A malformed row (wrong field count, an unparseable typed cell) is reported in `problems` and kept, never dropped.',
    inputs: [{ name: 'text', type: SCALAR_ITEM }],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'problems', type: SCALAR_LIST },
    ],
    params: [
      { name: 'columns', kind: 'json', doc: 'Optional [{ name, type }]; defaults to the header row, all columns typed `string`.' },
      { name: 'delimiter', kind: 'string', default: ',' },
      { name: 'key', kind: 'string', doc: 'Key column name; defaults to `GlobalId` when present, else the first column.' },
    ],
    capabilities: [],
    run: (_ctx, i, p) => {
      const text = String(i.text ?? '');
      const delimiter = typeof p.delimiter === 'string' && p.delimiter.length > 0 ? p.delimiter : ',';
      const parsed = parseCsvText(text, delimiter);
      const declared = specColumns(p.columns);
      const header = declared ? declared.map((c) => c.name) : parsed.header;
      const columns: Column[] = header.map((name, idx) => ({ name, type: columnType(declared?.[idx]) }));
      const problems: string[] = [];

      const rows = parsed.rows.map((r, rowIdx) => {
        if (r.fieldCountMismatch) {
          problems.push(`row ${rowIdx + 2}: expected ${header.length} field(s), got ${r.fields.length}`);
        }
        const row: Record<string, Cell> = {};
        columns.forEach((col, colIdx) => {
          const raw = r.fields[colIdx];
          if (raw === undefined) {
            row[col.name] = null;
            return;
          }
          if (col.type === 'string' || col.type === 'label' || col.type === 'identifier' || col.type === 'text' || col.type === 'enum' || col.type === 'reference') {
            row[col.name] = raw;
            return;
          }
          const parsedCell = parseStrictCell(raw, col.type);
          if (parsedCell === PARSE_INVALID) {
            problems.push(`row ${rowIdx + 2}: column "${col.name}": cannot parse "${raw}" as ${col.type}`);
            row[col.name] = null;
            return;
          }
          row[col.name] = Array.isArray(parsedCell) ? parsedCell.join(';') : parsedCell;
        });
        return row;
      });

      const key = typeof p.key === 'string' && p.key.length > 0 ? p.key : columns.some((c) => c.name === 'GlobalId') ? 'GlobalId' : (columns[0]?.name ?? 'GlobalId');
      const table: Table = { columns, rows, key: columns.some((c) => c.name === key) ? key : (columns[0]?.name ?? key) };
      return { table, problems };
    },
  },
  {
    type: 'table.writeCsv',
    title: 'Write CSV',
    category: 'table',
    doc: 'Serialises a table to RFC 4180 CSV text, guarding every cell against spreadsheet formula injection (CWE-1236).',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [{ name: 'text', type: SCALAR_ITEM }],
    params: [{ name: 'delimiter', kind: 'string', default: ',' }],
    capabilities: [],
    run: (_ctx, i, p) => {
      const t = tableOf(i.table);
      const delimiter = typeof p.delimiter === 'string' && p.delimiter.length > 0 ? p.delimiter : ',';
      const names = t.columns.map((c) => c.name);
      const text = tableToCsv(names, t.rows, { delimiter });
      return { text };
    },
  },
];
