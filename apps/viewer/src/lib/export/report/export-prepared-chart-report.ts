/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { browserReportSeams, generateReportPdf, type ReportPdfInput, type ReportPdfSeams } from './generate-report-pdf';
import { createSnapshotCapture } from './snapshots';
/** The dialog and agent share real PDF production and deterministic viewport restoration. */
export async function exportPreparedChartReport(input: ReportPdfInput, options: { seams?: ReportPdfSeams; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const needed = input.snapshots && input.charts.some(chart => chart.snapshot && (chart.aggregation?.categories.length ?? 0) > 0);
  const snapshot = options.seams || !needed ? null : createSnapshotCapture();
  try {
    const seams = options.seams ?? await browserReportSeams(snapshot?.capture ?? null);
    options.signal?.throwIfAborted(); const result = await generateReportPdf(input, seams);
    options.signal?.throwIfAborted(); return result;
  } finally { snapshot?.restore(); }
}
