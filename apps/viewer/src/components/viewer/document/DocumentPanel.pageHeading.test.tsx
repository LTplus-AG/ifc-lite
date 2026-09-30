/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { jsPDF } from 'jspdf';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { useViewerStore } from '@/store';
import { render, cleanup, type as typeInput, click, blur } from '@/test/render';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec } from '@/lib/document/types';
import { parseDocumentFile, loadDocuments } from '@/lib/document/persistence';
import { composeDocument } from '@/lib/document/compose';
import { pageBox, REPORT_MARGIN } from '@/lib/export/report/compose';
import { DocumentPanel } from './DocumentPanel';
import { generateDocumentPdf, browserImageSize } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';

afterEach(cleanup);
const spec: DocumentSpec = { version: DOCUMENT_VERSION, id: 'heading', name: 'Library name',
  page: { size: 'A4', orientation: 'portrait' }, blocks: [
    { kind: 'text', id: 'body', style: 'body', text: 'Inspection evidence' },
    { kind: 'page-break', id: 'next' },
    { kind: 'text', id: 'body2', style: 'body', text: 'Second section' },
  ] };
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

it('edits and resets each printed page heading without renaming the library document (#6554)', async () => {
  localStorage.clear();
  useViewerStore.setState({ documents: [structuredClone(spec)], activeDocumentId: spec.id, models: new Map(), activeModelId: null });
  const ui = render(<DocumentPanel />);
  const input = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading text"]');
  assert.ok(input, 'the page heading has its own actual editing control');
  typeInput(input, 'Authored handover');
  const font = ui.querySelector<HTMLSelectElement>('select[aria-label="Page heading font"]');
  assert.ok(font);
  act(() => { font.value = 'times'; font.dispatchEvent(new Event('change', { bubbles: true })); });
  const size = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading size"]');
  assert.ok(size); typeInput(size, '32'); blur(size);
  const color = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading colour"]');
  assert.ok(color); typeInput(color, '#6b21a8');
  await settle();
  const stored = useViewerStore.getState().documents[0];
  assert.equal(stored.name, 'Library name');
  assert.deepEqual(stored.pageHeading, { text: 'Authored handover', font: 'times', fontSize: 32, textColor: '#6b21a8' });
  const headings = [...ui.querySelectorAll<HTMLElement>('[data-page-heading]')];
  assert.equal(headings.length, 2);
  for (const heading of headings) {
    assert.equal(heading.textContent, 'Authored handover');
    assert.match(heading.style.fontFamily, /Times New Roman/);
    assert.ok(['#6b21a8', 'rgb(107, 33, 168)'].includes(heading.style.color));
    assert.ok(Math.abs(parseFloat(heading.style.fontSize) - 32 * 560 / pageBox(spec.page).w) < 0.01);
  }
  assert.deepEqual(loadDocuments()[0].pageHeading, stored.pageHeading);
  assert.deepEqual(parseDocumentFile(JSON.stringify(stored)).pageHeading, stored.pageHeading);
  const reset = ui.querySelector<HTMLButtonElement>('button[aria-label="Reset page heading"]');
  assert.ok(reset); click(reset); await settle();
  assert.equal(useViewerStore.getState().documents[0].pageHeading, undefined);
  for (const heading of ui.querySelectorAll('[data-page-heading]')) assert.equal(heading.textContent, 'Library name');
});

it('refuses invalid imported heading styles while older documents retain their defaults (#6554)', () => {
  assert.deepEqual(validateDocumentSpec(spec), []);
  const invalid = [
    ['text', 1], ['font', 'comic-sans'], ['font', null], ['fontSize', 5],
    ['fontSize', 49], ['fontSize', null], ['textColor', 'red'], ['textColor', '#abc'],
  ] as const;
  for (const [key, value] of invalid) {
    const raw = { ...spec, pageHeading: { [key]: value } };
    assert.ok(validateDocumentSpec(raw).some(error => error.path === `pageHeading.${key}`));
    assert.throws(() => parseDocumentFile(JSON.stringify(raw)), new RegExp(`pageHeading\\.${key}`));
  }
  for (const value of [null, [], 'title']) assert.ok(validateDocumentSpec({ ...spec, pageHeading: value }).some(error => error.path === 'pageHeading'));
});

it('keeps enlarged and unbroken headings inside the actual PDF font width and above page content (#6554)', () => {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const measure = (text: string, size: number, bold: boolean, font = 'helvetica') => {
    pdf.setFont(font, bold ? 'bold' : 'normal'); pdf.setFontSize(size); return pdf.getTextWidth(text);
  };
  const layout = composeDocument({ ...spec, blocks: spec.blocks.filter(block => block.kind === 'text' || block.kind === 'page-break'), pageHeading: { text: 'W'.repeat(800), font: 'courier', fontSize: 48, textColor: '#6b21a8' }, generatedAt: '', measure });
  assert.ok(layout.pageHeading);
  const heading = layout.pageHeading;
  assert.ok(measure(heading.text, heading.fontSize, false, heading.font) <= layout.size.w - 2 * REPORT_MARGIN);
  assert.ok(heading.y - heading.fontSize >= 0, 'enlarged ink is not clipped by the top page edge');
  for (const page of layout.pages) {
    const first = page.items.find(item => item.kind === 'text');
    assert.ok(first && first.y > heading.y + 8, 'every page reserves the enlarged heading before body ink');
  }
});

it('reserves an enlarged page heading when fitting titled images and their captions (#6554 / #6588)', () => {
  for (const size of ['A4', 'A3'] as const) for (const orientation of ['portrait', 'landscape'] as const) {
    const layout = composeDocument({ name: 'Library name', page: { size, orientation }, pageHeading: { fontSize: 48 }, generatedAt: '',
      blocks: [{ kind: 'image', id: 'image', height: 1200, align: 'left', aspect: 0.1, title: 'Authored image title', caption: 'Caption ink' }],
      measure: (text, fontSize) => text.length * fontSize / 2 });
    const bottom = layout.size.h - REPORT_MARGIN - 24;
    const image = layout.pages[0].items.find(item => item.kind === 'image');
    assert.ok(image?.kind === 'image');
    assert.ok(image.y + image.h <= bottom, 'actual image stays above the footer');
    const caption = layout.pages[0].items.find(item => item.kind === 'text' && item.text === 'Caption ink');
    assert.ok(caption && caption.y <= bottom, 'caption retains its reserved row below the image');
  }
});

it('prints the authored heading and actual standard font on every PDF page while keeping footer defaults (#6554)', async () => {
  // svg2pdf's Node UMD entry looks for its real jsPDF dependency on the
  // DOM window; the browser ESM entry resolves the same dependency directly.
  const pdfWindow = window as Window & { jspdf?: { jsPDF: typeof jsPDF } };
  const priorJsPdf = pdfWindow.jspdf;
  pdfWindow.jspdf = { jsPDF };
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
  result = await generateDocumentPdf({ document: { ...spec, pageHeading: { text: 'Authored handover', font: 'times', fontSize: 32, textColor: '#6b21a8' } },
    bindings: { models: [], activeModelId: null, today: new Date('2026-10-01') },
    aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] },
  { ...await browserReportSeams(null), imageSize: browserImageSize });
  } finally { pdfWindow.jspdf = priorJsPdf; }
  assert.equal(result.pages, 2);
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), enableXfa: false, stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const parsed = await task.promise;
    for (let number = 1; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number);
      try {
        const text = await page.getTextContent();
        const header = text.items.find(item => 'str' in item && item.str === 'Authored handover');
        assert.ok(header && 'str' in header, 'actual PDF text contains the authored heading');
        assert.equal(header.transform[0], 32);
        assert.equal(text.styles[header.fontName].fontFamily, 'serif');
        assert.equal(text.items.some(item => 'str' in item && item.str === 'Library name'), false);
        const footer = text.items.find(item => 'str' in item && item.str.startsWith('Page '));
        assert.ok(footer && 'str' in footer);
        assert.equal(footer.transform[0], 8, 'header styling does not leak into footer text');
        assert.equal(text.styles[footer.fontName].fontFamily, 'sans-serif');
        const operators = await page.getOperatorList();
        const inks = operators.fnArray.flatMap((op, index) => op === pdf.OPS.setFillRGBColor ? [operators.argsArray[index]] : []);
        assert.ok(inks.some(args => args[0] === '#6b21a8' || (args[0] === 107 && args[1] === 33 && args[2] === 168)),
          `actual PDF operators contain authored purple ink: ${JSON.stringify(inks)}`);
      } finally { page.cleanup(); }
    }
  } finally { await task.destroy(); }
});
