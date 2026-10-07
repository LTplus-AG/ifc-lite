/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Print a native document through the real jsPDF path and read the text back
 * with pdf.js using only the standard fonts, so a test sees what a reader of
 * the PDF sees (#6918). Text-only documents: image measurement is refused.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentSpec } from '@/lib/document/types';

export interface PrintedDocument { text: string; pages: number; unresolved: unknown[] }

export async function printDocumentText(document: DocumentSpec,
  bindings: BindingContext = { models: [], activeModelId: null, today: new Date() }): Promise<PrintedDocument> {
  const { generateDocumentPdf } = await import('@/lib/document/generate-document-pdf');
  const { browserReportSeams } = await import('@/lib/export/report/generate-report-pdf');
  const jspdf = await import('jspdf');
  const previous = Reflect.get(window, 'jspdf');
  Reflect.set(window, 'jspdf', jspdf);
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document, bindings,
      aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: async () => { throw new Error('Text-only report must not measure images'); } });
  } finally { Reflect.set(window, 'jspdf', previous); }
  const require = createRequire(import.meta.url);
  const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const pdf = await task.promise;
    assert.equal(pdf.numPages, result.pages);
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try { pages.push((await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('\n')); }
      finally { page.cleanup(); }
    }
    return { text: pages.join('\n'), pages: pdf.numPages, unresolved: result.unresolved };
  } finally { await task.destroy(); }
}
