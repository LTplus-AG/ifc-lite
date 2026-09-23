/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal RFC 4180 CSV text parser, split out of `csv-nodes.ts` so that
 * module stays small. This is a READER, not the CWE-1236 escaper — writing
 * goes through `@ifc-lite/export`'s `tableToCsv`/`escapeCsvCell`, the one
 * canonical implementation `scripts/check-csv-escaper-copies.mjs` gates.
 *
 * Handles quoted fields (`"a,b"`), doubled-quote escaping (`"a""b"` → `a"b`),
 * and both `\n` and `\r\n` line endings. A field is never dropped: a row with
 * too few or too many fields relative to the header is still parsed and
 * returned, with a `fieldCountMismatch` flag the caller reports instead of
 * silently truncating or padding.
 */

export interface CsvParseRow {
  readonly fields: readonly string[];
  /** True when this row's field count does not match the header's. */
  readonly fieldCountMismatch: boolean;
}

export interface CsvParseResult {
  readonly header: readonly string[];
  readonly rows: readonly CsvParseRow[];
}

/** Split raw CSV text into fields per physical row, honouring quoting. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // A trailing field/row with no terminating newline is still real content.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Parse CSV text into a header row and data rows. Blank trailing rows (a
 *  file ending in a newline) are dropped; a genuinely blank line elsewhere
 *  is kept as a one-empty-field row and reported like any other mismatch. */
export function parseCsvText(text: string, delimiter = ','): CsvParseResult {
  const all = splitRows(text, delimiter).filter((r, idx, arr) => !(idx === arr.length - 1 && r.length === 1 && r[0] === ''));
  if (all.length === 0) return { header: [], rows: [] };
  const [header, ...dataRows] = all;
  const width = header.length;
  const rows: CsvParseRow[] = dataRows.map((fields) => ({ fields, fieldCountMismatch: fields.length !== width }));
  return { header, rows };
}
