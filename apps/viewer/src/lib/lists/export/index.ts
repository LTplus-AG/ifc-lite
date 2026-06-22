/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List results export — CSV / Excel / PDF, all driven by one normalised model
 * (columns, grouping, sums, totals). Excel and PDF writers (and their heavy
 * libs) are lazy-loaded so they never touch the initial bundle.
 */

import { toCsv } from './csv';
import type { ExportModel } from './model';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV (.csv)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
};

/**
 * Make a user-supplied list name safe to use as a download filename without
 * mangling it. Case is preserved (so `DRAWINGS` stays `DRAWINGS`) and dots are
 * kept (so a classification code like `000.000` survives intact). Only
 * characters that are unsafe in filenames are replaced; whitespace runs collapse
 * to a single space and leading/trailing separators are trimmed.
 */
export function sanitizeFilename(s: string): string {
  const cleaned = (s || 'list')
    .replace(/\s+/g, ' ') // collapse all whitespace (tabs, newlines, runs) to one space
    // Keep letters (any case/script), digits, dot, underscore, space and hyphen;
    // replace anything else (path separators, reserved chars, controls) with '-'.
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '') // trim leading/trailing space, dot or hyphen
    .slice(0, 60)
    .replace(/[\s.-]+$/, ''); // re-trim in case slice() left a trailing separator
  return cleaned || 'list';
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function exportList(format: ExportFormat, model: ExportModel): Promise<void> {
  const name = sanitizeFilename(model.title);
  if (format === 'csv') {
    download(new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8;' }), `${name}.csv`);
  } else if (format === 'xlsx') {
    const { toXlsx } = await import('./xlsx');
    download(await toXlsx(model), `${name}.xlsx`);
  } else {
    const { toPdf } = await import('./pdf');
    download(await toPdf(model), `${name}.pdf`);
  }
}

export { buildExportModel } from './model';
export type { ExportModel } from './model';
