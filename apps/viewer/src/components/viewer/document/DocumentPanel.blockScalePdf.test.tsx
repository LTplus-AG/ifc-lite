/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-block size (#6548) through the REAL PDF seams: jsPDF with jspdf-autotable draws a table block,
 * and the text it printed is read back with pdf.js. The recording seams in `document-scale.test.ts` check
 * what the composer asks for; this checks that the browser seam turns the factor into font size, cell
 * padding and row height.
 */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { generateDocumentPdf, browserImageSize } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';

const state = { status: 'ok' as const, kind: 'validation' as const, model: {
  columns: [{ label: 'Rule', numeric: false }],
  rows: [{ role: 'row' as const, cells: ['Row one'] }, { role: 'row' as const, cells: ['Row two'] }],
  totalRows: 2,
} };

async function tableText(scale?: number): Promise<Array<{ str: string; size: number; baseline: number }>> {
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'table', id: 'tb', ...(scale ? { scale } : {}), source: { kind: 'validation', rows: 'failed', columns: ['rule'] } }] };
  // svg2pdf's Node UMD entry looks for its jsPDF dependency on the DOM window.
  const pdfWindow = window as Window & { jspdf?: { jsPDF: typeof jsPDF } };
  const prior = pdfWindow.jspdf;
  pdfWindow.jspdf = { jsPDF };
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date('2026-10-01') },
      aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map([['tb', state]]), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: browserImageSize });
  } finally { pdfWindow.jspdf = prior; }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), enableXfa: false, stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    return content.items.flatMap((item) => ('str' in item && item.str.startsWith('Row') ? [{ str: item.str, size: item.transform[0], baseline: item.transform[5] }] : []));
  } finally { await task.destroy(); }
}

it('draws a scaled table block with its font and row pitch scaled by the factor (#6548)', async () => {
  const one = await tableText();
  const two = await tableText(2);
  assert.deepEqual(one.map((t) => t.str), ['Row one', 'Row two']);
  assert.deepEqual(two.map((t) => t.str), ['Row one', 'Row two']);
  assert.equal(one[0].size, 8, 'the default table text is 8pt');
  assert.equal(two[0].size, 16, 'at 2x it is 16pt');
  const pitch = (rows: typeof one) => Math.abs(rows[0].baseline - rows[1].baseline);
  assert.ok(Math.abs(pitch(one) - 13.2) < 0.1, `row pitch at 1x is ${pitch(one)}`);
  assert.ok(Math.abs(pitch(two) - 26.4) < 0.1, `row pitch at 2x is ${pitch(two)}`);
});
