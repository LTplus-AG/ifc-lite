/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List results export — CSV / Excel / PDF, all driven by one normalised model
 * (columns, grouping, sums, totals). Excel and PDF writers (and their heavy
 * libs) are lazy-loaded so they never touch the initial bundle.
 */

import { downloadBlob, sanitizeFilename } from '../../export/download';
import { toCsv } from './csv';
import type { ExportModel } from './model';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV (.csv)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
};

export async function exportList(format: ExportFormat, model: ExportModel): Promise<void> {
  const name = sanitizeFilename(model.title, { fallback: 'list' });
  if (format === 'csv') {
    downloadBlob(new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8;' }), `${name}.csv`);
  } else if (format === 'xlsx') {
    const { toXlsx } = await import('./xlsx');
    downloadBlob(await toXlsx(model), `${name}.xlsx`);
  } else {
    const { toPdf } = await import('./pdf');
    downloadBlob(await toPdf(model), `${name}.pdf`);
  }
}

export { buildExportModel } from './model';
export type { ExportModel } from './model';
