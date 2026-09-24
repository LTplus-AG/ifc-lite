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
import { readXlsxTable, writeXlsxTable } from './xlsx-io.js';
import { SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, type FlowNodeDef } from './host.js';

/**
 * Base64 without `Buffer` or `btoa`/`atob`: this package runs in the browser
 * (`viewer-embed`) as well as headlessly, and neither global is guaranteed —
 * `Buffer` needs a bundler polyfill most Vite configs do not add, and `atob`
 * mangles bytes above 0x7F on some hosts' string-vs-binary handling. A tiny
 * table-driven codec sidesteps both.
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.endsWith('==') ? clean.length - 2 : clean.endsWith('=') ? clean.length - 1 : clean.length;
  const byteLength = Math.floor((len * 6) / 8);
  const out = new Uint8Array(byteLength);
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (let i = 0; i < len; i += 1) {
    value = (value << 6) | BASE64_CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx] = (value >> bits) & 0xff;
      outIdx += 1;
    }
  }
  return out;
}

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
