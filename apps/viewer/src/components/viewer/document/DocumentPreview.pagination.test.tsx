/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { jsPDF } from 'jspdf';
import { render, cleanup } from '@/test/render';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { DocumentPreview } from './DocumentPreview';

afterEach(cleanup);
const bindings = { models: [], activeModelId: null, today: new Date('2026-10-02T12:00:00Z') };
const spec = (blocks: DocumentSpec['blocks']): DocumentSpec => ({
  version: DOCUMENT_VERSION, id: 'pagination', name: 'Inspection handover',
  page: { size: 'A4', orientation: 'portrait' }, blocks,
});

async function printedPages(document: DocumentSpec): Promise<string[]> {
  // Node's svg2pdf UMD resolves its actual jsPDF dependency from the DOM
  // window; browser ESM resolves it directly. No SVG/PDF output is replaced.
  const pdfWindow = window as Window & { jspdf?: { jsPDF: typeof jsPDF } };
  const prior = pdfWindow.jspdf;
  pdfWindow.jspdf = { jsPDF };
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document, bindings, aggregations: new Map(),
      chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: browserImageSize });
  } finally { pdfWindow.jspdf = prior; }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()),
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`,
    stopAtErrors: true });
  try {
    const parsed = await task.promise;
    const texts: string[] = [];
    for (let n = 1; n <= parsed.numPages; n++) {
      const page = await parsed.getPage(n);
      try { texts.push((await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('\n')); }
      finally { page.cleanup(); }
    }
    assert.equal(parsed.numPages, result.pages, 'the actual PDF agrees with the export result');
    return texts;
  } finally { await task.destroy(); }
}

async function preview(document: DocumentSpec) {
  const ui = render(<DocumentPreview document={document} bindings={bindings}
    aggregations={new Map()} chartMessages={new Map()} topics={new Map()}
    selectedBlockId={null} onSelectBlock={() => {}} />);
  for (let n = 0; n < 8; n++) await act(async () => { await Promise.resolve(); });
  return ui;
}

it('shows the actual two PDF pages when text overflows without an authored page break (#6610)', async () => {
  // 100 short, explicit lines exceed one A4 body frame without relying on
  // browser word-wrapping, fonts or an artificial list of page breaks.
  const text = Array.from({ length: 100 }, (_, n) => `Inspection line ${String(n + 1).padStart(3, '0')}`).join('\n');
  const document = spec([{ kind: 'text', id: 'evidence', style: 'body', text }]);
  const pages = await printedPages(document);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /Inspection line 001/);
  assert.match(pages[1], /Inspection line 100/);
  const ui = await preview(document);
  const sheets = [...ui.querySelectorAll('[data-preview-section]')];
  assert.equal(sheets.length, pages.length, 'preview must show the automatic page created by the existing PDF composer');
  assert.match(sheets[0].textContent ?? '', /Inspection line 001/);
  assert.doesNotMatch(sheets[0].textContent ?? '', /Inspection line 100/);
  assert.match(sheets[1].textContent ?? '', /Inspection line 100/);
});

it('repeats truthful page counters on explicit and automatic preview pages (#6610)', async () => {
  const document = spec([
    { kind: 'text', id: 'first', style: 'body', text: 'First inspection evidence' },
    { kind: 'page-break', id: 'break' },
    { kind: 'text', id: 'second', style: 'body', text: 'Second inspection evidence' },
  ]);
  const pages = await printedPages(document);
  const ui = await preview(document);
  const sheets = [...ui.querySelectorAll('[data-preview-section]')];
  assert.equal(sheets.length, 2, 'existing explicit page breaks remain two sheets');
  for (let n = 0; n < pages.length; n++) {
    const counter = `Page ${n + 1} / ${pages.length}`;
    assert.ok(pages[n].includes(counter), 'actual PDF contains its existing default page counter');
    assert.ok(sheets[n].textContent?.includes(counter), 'preview must expose the same current page and total');
  }
});
