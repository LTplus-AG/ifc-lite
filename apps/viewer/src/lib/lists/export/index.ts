/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List results export — CSV / Excel / PDF, all driven by one normalised model
 * (columns, grouping, sums, totals). Excel and PDF writers (and their heavy
 * libs) are lazy-loaded so they never touch the initial bundle.
 */

import { csvBlob, downloadBlob, sanitizeFilename } from '../../export/download';
import { trackExportCompleted } from '../../analytics';
import { toCsv } from './csv';
import type { ExportModel } from './model';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV (.csv)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
};

/** Produce the real native writer artifact before delivery by UI or automation. */
export async function createListArtifact(
  format: ExportFormat, model: ExportModel, options: { csvBom?: boolean } = {},
): Promise<{ blob: Blob; filename: string }> {
  const name = sanitizeFilename(model.title, { fallback: 'list' });
  if (format === 'csv') {
    const csv = toCsv(model);
    const type = 'text/csv;charset=utf-8;';
    const blob = options.csvBom ? csvBlob(csv, type) : new Blob([csv], { type });
    return { blob, filename: `${name}.csv` };
  }
  if (format === 'xlsx') {
    const { toXlsx } = await import('./xlsx');
    return { blob: await toXlsx(model), filename: `${name}.xlsx` };
  }
  const { toPdf } = await import('./pdf');
  return { blob: await toPdf(model), filename: `${name}.pdf` };
}

export async function exportList(format: ExportFormat, model: ExportModel): Promise<void> {
  const artifact = await createListArtifact(format, model, { csvBom: true });
  downloadBlob(artifact.blob, artifact.filename);
  // The results table is this exporter's only UI caller. Count the file once,
  // after the chosen writer and browser download have both succeeded.
  trackExportCompleted({
    format, surface: 'list_results', row_count: model.totals.count, column_count: model.columns.length,
  });
}

export { buildExportModel } from './model';
export type { ExportModel } from './model';
