/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { jsPDF } from 'jspdf';
import { useViewerStore } from '@/store';
import { render, cleanup, type as typeInput, click } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec } from '@/lib/document/types';
import { parseDocumentFile, loadDocuments } from '@/lib/document/persistence';
import { generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { DocumentPanel } from './DocumentPanel';
import { composeDocument, estimateTextWidth } from '@/lib/document/compose';
import { documentChartLayout } from '@/lib/document/compose-sizing';

const today = new Date('2026-10-02T12:00:00Z');
const lines = Array.from({ length: 100 }, (_, i) => `Evidence line ${String(i + 1).padStart(3, '0')}`).join('\n');
const base: DocumentSpec = { version: DOCUMENT_VERSION, id: 'bands', name: 'Library document',
  page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'evidence', style: 'body', text: lines }] };
const icon = readFileSync(new URL('../../../../public/favicon-16x16-cropped.png', import.meta.url));
const logo = { dataUrl: `data:image/png;base64,${icon.toString('base64')}`, height: 60 };
const authored = () => parseDocumentFile(JSON.stringify({ ...base,
  pageHeading: { text: 'Issued for coordination', font: 'times', fontSize: 12, logo, showDate: true, showPageNumbers: true },
  pageFooter: { text: 'Controlled report copy', font: 'courier', fontSize: 10,
    logo: { ...logo, height: 40 }, showDate: true, showPageNumbers: true },
}));

// Import owns fresh identities; every authored value and binding is otherwise preserved.
function assertImportedPayload(imported: DocumentSpec, source: DocumentSpec): void {
  assert.notEqual(imported.id, source.id);
  assert.match(imported.id, /^document-/);
  assert.equal(imported.blocks.length, source.blocks.length);
  assert.equal(new Set(imported.blocks.map(block => block.id)).size, source.blocks.length);
  for (const block of imported.blocks) {
    assert.match(block.id, /^block-/);
    assert.ok(source.blocks.every(original => original.id !== block.id));
  }
  assert.deepEqual({ ...imported, id: source.id,
    blocks: imported.blocks.map((block, index) => ({ ...block, id: source.blocks[index].id })),
  }, source, 'import preserves the full authored payload, including unresolved template bindings (#6610)');
}

afterEach(() => { cleanup(); localStorage.clear(); });

async function print(document: DocumentSpec, captured = today) {
  const pdfWindow = window as Window & { jspdf?: { jsPDF: typeof jsPDF } };
  const prior = pdfWindow.jspdf; pdfWindow.jspdf = { jsPDF };
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: captured },
      aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] },
    { ...await browserReportSeams(null), now: () => captured,
      // Measure the actual committed PNG's IHDR, not a fabricated image size.
      imageSize: async dataUrl => { const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }; },
    });
  } finally { pdfWindow.jspdf = prior; }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const parsed = await task.promise;
    assert.equal(parsed.numPages, result.pages);
    const pages = [];
    for (let number = 1; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number);
      try {
        const content = await page.getTextContent();
        const items = content.items.flatMap(item => 'str' in item ? [item] : []);
        const operators = await page.getOperatorList();
        pages.push({ number, width: page.view[2], height: page.view[3], items,
          fills: operators.fnArray.flatMap((op, index) => op === pdf.OPS.setFillRGBColor ? [operators.argsArray[index][0] as string] : []),
          text: items.map(item => item.str).join('\n'),
          images: operators.fnArray.filter(op => op === pdf.OPS.paintImageXObject || op === pdf.OPS.paintInlineImageXObject).length });
      } finally { page.cleanup(); }
    }
    return pages;
  } finally { await task.destroy(); }
}

it('repeats authored header/footer text, captured date, logos and current/total counters on actual overflow PDF pages (#6610)', async () => {
  const pages = await print(authored());
  assert.ok(pages.length >= 2, 'real body content overflows the measured frame');
  for (const page of pages) {
    assert.match(page.text, /Issued for coordination/);
    assert.match(page.text, /Controlled report copy/);
    const dates = page.items.filter(item => item.str === '2026-10-02');
    assert.equal(dates.length, 2, 'exactly the two authored bands print the captured date (#6733)');
    assert.equal(page.text.split(`Page ${page.number} / ${pages.length}`).length - 1, 2, 'each band prints its truthful counter');
    assert.equal(page.images, 2, 'both embedded logos actually reach every PDF page');
    const header = page.items.find(item => item.str === 'Issued for coordination');
    const footer = page.items.find(item => item.str === 'Controlled report copy');
    assert.ok(header && footer);
    assert.equal(dates.filter(item => item.transform[5] > page.height / 2).length, 1, 'exactly one date is in the upper band');
    assert.equal(dates.filter(item => item.transform[5] < page.height / 2).length, 1, 'exactly one date is in the lower band');
    assert.equal(header.transform[0], 12, 'authored header typography reaches the real PDF');
    assert.equal(footer.transform[0], 10, 'the footer keeps its independent authored size');
    const body = page.items.filter(item => item.str.startsWith('Evidence line '));
    assert.ok(body.length > 0);
    assert.ok(body.every(item => item.transform[5] < header.transform[5] - 50
      && item.transform[5] > footer.transform[5] + 30), 'all body glyph baselines stay clear of the reserved logo bands');
  }
  const text = pages.map(page => page.text).join('\n');
  for (let i = 1; i <= 100; i++) assert.ok(text.includes(`Evidence line ${String(i).padStart(3, '0')}`), 'overflow preserves every body line');
});

it('prints truthful two-digit totals on every explicit page and captures the local day (#6610)', async () => {
  const document = authored();
  document.blocks = Array.from({ length: 11 }, (_, index): DocumentSpec['blocks'] => [
    ...(index > 0 ? [{ kind: 'page-break' as const, id: `break-${index}` }] : []),
    { kind: 'text', id: `text-${index}`, style: 'body', text: `Explicit evidence ${index + 1}` },
  ]).flat();
  const pages = await print(document, new Date(2026, 9, 2, 0, 30));
  assert.equal(pages.length, 11);
  for (const page of pages) {
    assert.equal(page.text.split(`Page ${page.number} / 11`).length - 1, 2);
    assert.equal(page.text.match(/2026-10-02/g)?.length, 2, 'date stamps use the captured local day at midnight');
    assert.ok(page.text.includes(`Explicit evidence ${page.number}`));
    assert.equal(page.images, 2);
  }
});

it('authors and resets an actual footer through the mounted editor, persisted import and composed preview (#6610)', async () => {
  localStorage.clear();
  useViewerStore.setState({ documents: [structuredClone(base)], activeDocumentId: base.id, models: new Map(), activeModelId: null });
  const ui = render(<DocumentPanel />);
  const footer = ui.querySelector<HTMLInputElement>('input[aria-label="Page footer text"]');
  assert.ok(footer, 'footer authoring is available in the actual Document panel');
  typeInput(footer, 'Controlled report copy');
  const date = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading date"]');
  const counter = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading page numbers"]');
  assert.ok(date && counter); click(date); click(counter);
  await documentPreviewReady();
  const sheets = [...ui.querySelectorAll('[data-preview-section]')];
  assert.ok(sheets.length >= 2);
  for (const sheet of sheets) {
    assert.match(sheet.querySelector('[data-page-footer]')?.textContent ?? '', /Controlled report copy/);
    assert.equal(sheet.querySelectorAll('[data-page-counter]').length, 2);
  }
  const stored = useViewerStore.getState().documents[0];
  const imported = parseDocumentFile(JSON.stringify(stored));
  assertImportedPayload(imported, stored);
  await useViewerStore.getState().retryDocumentsSave();
  assert.deepEqual((await loadDocuments())[0], stored);
  const pages = await print(imported);
  assert.equal(pages.length, sheets.length);
  assert.ok(pages.every(page => page.text.includes('Controlled report copy')));
  const reset = ui.querySelector<HTMLButtonElement>('button[aria-label="Reset page footer"]');
  assert.ok(reset); click(reset); await documentPreviewReady();
  assert.equal(Reflect.get(useViewerStore.getState().documents[0], 'pageFooter'), undefined);
  const resetFooters = [...ui.querySelectorAll('[data-page-footer]')];
  assert.equal(resetFooters.length, sheets.length, 'reset keeps every mounted footer (#6733)');
  assert.ok(resetFooters.length > 0);
  assert.ok(resetFooters.every(node => node.textContent?.includes('Generated ')
    && !node.textContent.includes('Controlled report copy')));
});

it('refuses malformed imported band options before the writer/layout can consume them (#6610)', () => {
  for (const field of ['pageHeading', 'pageFooter']) for (const invalid of [
    { showDate: 'yes' }, { showPageNumbers: 1 }, { logo: { ...logo, height: Infinity } },
    { logo: { ...logo, height: 0 } }, { logo: { ...logo, dataUrl: 'data:image/svg+xml;base64,AAAA' } },
  ]) {
    const errors = validateDocumentSpec({ ...base, [field]: invalid });
    assert.ok(errors.some(error => error.path.startsWith(`${field}.`)), `${field}: ${JSON.stringify(invalid)}`);
  }
});

it('preserves existing no-band PDF text, counters, frame positions and overflow defaults (#6610)', async () => {
  const pages = await print(base);
  assert.equal(pages.length, 2);
  for (const page of pages) {
    assert.ok(page.text.includes('Library document'));
    assert.ok(page.text.includes('Generated '));
    assert.ok(page.text.includes(`Page ${page.number} / 2`));
    assert.equal(page.images, 0);
    const heading = page.items.find(item => item.str === 'Library document');
    const body = page.items.find(item => item.str.startsWith('Evidence line '));
    assert.ok(heading && body);
    assert.equal(heading.transform[0], 8);
    assert.ok(Math.abs(heading.transform[4] - 40) < 0.01);
    assert.ok(Math.abs(page.height - heading.transform[5] - 32) < 0.01);
    assert.ok(Math.abs(page.height - body.transform[5] - 80) < 0.01);
  }
  assert.ok(pages[1].text.includes('Evidence line 100'));
});


it('migrates an old version-11 document without inventing authored footer content (#6610)', () => {
  const old: Omit<DocumentSpec, 'version'> & { version: 11 } = { ...base, version: 11,
    pageHeading: { text: 'Existing {project.name} heading', font: 'times', fontSize: 12 },
    blocks: [{ kind: 'text', id: 'evidence', style: 'body', text: `${lines}\n{project.name}` }],
  };
  const migrated = parseDocumentFile(JSON.stringify(old));
  assert.equal(migrated.version, DOCUMENT_VERSION);
  assert.deepEqual(migrated.pageHeading, old.pageHeading);
  assert.equal(migrated.pageFooter, undefined);
  assertImportedPayload(migrated, { ...old, version: DOCUMENT_VERSION });
});

it('keeps legacy chart/snapshot minima separate from measured authored-band frames (#6733)', () => {
  const sizing = { requestedHeight: 400, pageHeight: 200, boxWidth: 300, snapshot: true, hasData: true };
  const legacy = documentChartLayout(sizing);
  assert.equal(legacy.height, 40); assert.equal(legacy.snapshotHeight, 40);
  const bounded = documentChartLayout({ ...sizing, printableHeight: 66 });
  assert.ok(bounded.totalHeight <= 66); assert.equal(bounded.snapshotHeight, 0);
  const layout = composeDocument({ name: 'Legacy', page: { size: 'A4', orientation: 'landscape' },
    pageHeading: { text: 'Legacy configured heading', fontSize: 48 }, generatedAt: '', measure: estimateTextWidth,
    blocks: [{ kind: 'chart', id: 'chart', title: 'Legacy stacked chart', subtitle: '', snapshot: true,
      hasData: true, scale: 2, fontSize: 24, titleFontSize: 24 }] });
  const items = layout.pages.flatMap(page => page.items);
  assert.ok(items.some(item => item.kind === 'chart' && item.h > 0));
  assert.ok(items.some(item => item.kind === 'snapshot' && item.h > 0));
});

it('keeps the configured legacy text-only heading default ink in actual PDF operators (#6733)', async () => {
  const pages = await print({ ...base, pageHeading: { text: 'Legacy configured heading', font: 'times', fontSize: 20 } });
  for (const page of pages) {
    const heading = page.items.find(item => item.str === 'Legacy configured heading'); assert.ok(heading);
    assert.equal(heading.transform[0], 20);
    assert.ok(page.fills.includes('#969696'), 'canonical default ink is RGB 150/150/150');
    assert.ok(page.text.includes('Generated '));
  }
});
