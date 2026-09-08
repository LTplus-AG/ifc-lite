/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Result-table export — pure formatters + a Blob download trigger.
 *
 * `formatCsv` and `formatJson` are pure (testable in node:test); the
 * download helper is browser-only and DOM-touching, so we keep it in
 * the same module but isolated from the formatters.
 */

import { escapeCsvCell as escapeCsvCellShared } from '@ifc-lite/export';
import { downloadFile, sanitizeFilename } from '../export/download.js';

export interface ExportResult {
  columns: string[];
  rows: unknown[][];
}

/** Cells DuckDB sometimes returns as Object / BigInt — normalise to a
 *  string the spreadsheet / JSON consumers can actually read. */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'string') return v;
  // Fallback for Object / Date / Arrow row helpers — JSON.stringify is
  // safe and round-trippable; CSV consumers see the JSON literal.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** RFC-4180 quoting + the CWE-1236 formula-injection guard.
 *
 *  Delegates to `@ifc-lite/export`'s single escaper — the copy that used to
 *  live here bought its invisible-handling by DELETING the leading run of
 *  `\p{Cf}\p{Z}`. `\p{Z}` includes U+0020, so every exported cell silently lost
 *  its leading spaces, against RFC 4180 §2.4 ("Spaces are considered part of a
 *  field and should not be ignored"). The shared escaper looks *past* the run
 *  instead of removing it, guarding the same payloads without touching data. */
function escapeCsvCell(raw: string): string {
  return escapeCsvCellShared(raw, { delimiter: ',' });
}

/** Serialize a result set to CSV (UTF-8). Trailing newline included. */
export function formatCsv(result: ExportResult): string {
  const lines: string[] = [];
  lines.push(result.columns.map((c) => escapeCsvCell(c)).join(','));
  for (const row of result.rows) {
    const cells: string[] = [];
    for (let i = 0; i < result.columns.length; i++) {
      cells.push(escapeCsvCell(cellToString(row[i])));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

/** Serialize a result set to a pretty-printed JSON array of objects.
 *  bigint / Date / object cells are stringified through cellToString
 *  for round-trip consistency with CSV export. */
export function formatJson(result: ExportResult): string {
  const out = result.rows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < result.columns.length; i++) {
      obj[result.columns[i]] = cellToString(row[i]);
    }
    return obj;
  });
  return JSON.stringify(out, null, 2);
}

/** Build the `Blob` + download flow for a result. The caller passes a "stem"
 *  that becomes the filename root (`stem.csv`). Browser-only — does nothing
 *  useful when `document` is missing. */
export function downloadResult(
  result: ExportResult,
  format: 'csv' | 'json',
  filenameStem = 'ifc-query',
): void {
  const content = format === 'csv' ? formatCsv(result) : formatJson(result);
  const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
  const name = sanitizeFilename(filenameStem, { fallback: 'query' });
  downloadFile(content, `${name}.${format}`, mime);
}

/** Exposed for tests. */
export const __internal = { escapeCsvCell, cellToString };
