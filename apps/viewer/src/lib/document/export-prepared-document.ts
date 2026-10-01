/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { browserReportSeams } from '../export/report/generate-report-pdf';
import { createSnapshotCapture } from '../export/report/snapshots';
import { browserImageSize, generateDocumentPdf, type DocumentPdfInput, type DocumentPdfResult, type DocumentPdfSeams } from './generate-document-pdf';

/** Uses the native renderer and always restores the viewport capture resources. */
export async function exportPreparedDocument(input: DocumentPdfInput,
  options: { signal?: AbortSignal; seams?: DocumentPdfSeams } = {},
): Promise<DocumentPdfResult> {
  options.signal?.throwIfAborted();
  const snapshot = options.seams ? null : createSnapshotCapture();
  try {
    const seams = options.seams ?? { ...await browserReportSeams(snapshot?.capture ?? null), imageSize: browserImageSize };
    options.signal?.throwIfAborted();
    const result = await generateDocumentPdf(input, seams);
    options.signal?.throwIfAborted();
    return result;
  } finally { snapshot?.restore(); }
}

export function documentPdfWarnings(result: DocumentPdfResult): string[] {
  return [
    ...result.unresolved.map((path) => `Unresolved binding: ${path}`),
    ...result.missingTopics.map((guid) => `Missing BCF topic: ${guid}`),
    ...result.snapshotFailures.map((name) => `3D snapshot unavailable: ${name}`),
    ...result.imageFailures.map((name) => `Image unavailable: ${name}`),
    ...result.tableFailures.map((id) => `Table unavailable: ${id}`),
    ...(result.chartFailures ?? []).map((message) => `Chart unavailable: ${message}`),
  ];
}
