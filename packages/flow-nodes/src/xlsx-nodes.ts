/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `table.readXlsx` / `table.writeXlsx` — flow-node wrappers over `xlsx-io.ts`.
 *
 * A flow `Scalar` is `string | number | boolean | null` (no bytes), so a
 * workbook travels an edge as base64 text — the same encoding `bim.files`
 * attachments already use for binary payloads elsewhere in the SDK.
 */

import { tableOf } from './table-nodes.js';
import { fromBase64, toBase64 } from './base64.js';
import { readXlsxTable, writeXlsxTable } from './xlsx-io.js';
import { SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, type FlowNodeDef } from './host.js';

export const xlsxNodes: FlowNodeDef[] = [
  {
    type: 'table.readXlsx',
    title: 'Read XLSX',
    category: 'table',
    doc: 'Reads one sheet of a base64-encoded .xlsx workbook into a typed table. A row wider than the header is reported, never dropped.',
    inputs: [{ name: 'data', type: SCALAR_ITEM }],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'problems', type: SCALAR_LIST },
    ],
    params: [
      { name: 'sheet', kind: 'string', doc: 'Sheet name; defaults to the first worksheet.' },
      { name: 'columns', kind: 'json', doc: 'Optional [{ name, type }]; defaults to the header row, all columns typed `string`.' },
      { name: 'key', kind: 'string' },
    ],
    capabilities: [],
    run: async (_ctx, i, p) => {
      const bytes = fromBase64(String(i.data ?? ''));
      const columns = Array.isArray(p.columns) ? (p.columns as { name: string; type?: string }[]) : undefined;
      const { table, problems } = await readXlsxTable(bytes, {
        sheet: typeof p.sheet === 'string' && p.sheet.length > 0 ? p.sheet : undefined,
        columns,
        key: typeof p.key === 'string' && p.key.length > 0 ? p.key : undefined,
      });
      return { table, problems };
    },
  },
  {
    type: 'table.writeXlsx',
    title: 'Write XLSX',
    category: 'table',
    doc: 'Writes a table to a flat, single-sheet .xlsx workbook, base64-encoded, guarding every string cell against spreadsheet formula injection (CWE-1236).',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [{ name: 'data', type: SCALAR_ITEM }],
    params: [{ name: 'sheet', kind: 'string', default: 'Sheet1' }],
    capabilities: [],
    run: async (_ctx, i, p) => {
      const t = tableOf(i.table);
      const sheet = typeof p.sheet === 'string' && p.sheet.length > 0 ? p.sheet : 'Sheet1';
      const bytes = await writeXlsxTable(t, sheet);
      return { data: toBase64(bytes) };
    },
  },
];
