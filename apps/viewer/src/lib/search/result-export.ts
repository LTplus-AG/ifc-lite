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

/** RFC-4180-style escaping: quote any cell containing comma, quote, or
 *  newline; double-up embedded quotes inside the wrapped cell. */
function escapeCsvCell(raw: string): string {
  if (raw.length === 0) return '';
  const needsQuotes = raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r');
  if (!needsQuotes) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

/** Serialize a result set to CSV (UTF-8) with RFC-4180 CRLF line
 *  endings. Trailing CRLF included. Excel and most strict CSV parsers
 *  require CRLF; LF-only worked in tolerant parsers but failed in
 *  Excel's "Get Data" import on some Windows configurations. */
const CRLF = '\r\n';
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
  return lines.join(CRLF) + CRLF;
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

/** Sanitise a stem for use as a download filename — strip path-unsafe
 *  characters, fall back to `query`. */
function sanitiseFilenameStem(stem: string): string {
  const cleaned = stem.replace(/[^a-zA-Z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'query';
}

/** Build the `Blob` + temporary `<a>` download flow for a result. The
 *  caller passes a "stem" that becomes the filename root (`stem.csv`).
 *  Browser-only — does nothing useful when `document` is missing. */
export function downloadResult(
  result: ExportResult,
  format: 'csv' | 'json',
  filenameStem = 'ifc-query',
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;

  const content = format === 'csv' ? formatCsv(result) : formatJson(result);
  const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitiseFilenameStem(filenameStem)}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Exposed for tests. */
export const __internal = { escapeCsvCell, cellToString, sanitiseFilenameStem };
