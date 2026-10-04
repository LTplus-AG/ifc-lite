/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, cleanup, waitFor } from '@/test/render';
import { DocumentPreview } from '@/components/viewer/document/DocumentPreview';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as jspdf from 'jspdf';
import { IfcParser } from '@ifc-lite/parser';
import * as translations from '@/i18n/registry';
import { browserReportSeams } from '../export/report/generate-report-pdf';
import { composeDocument } from './compose';
import { generateDocumentPdf, resolveBlocks, type DocumentPdfInput, type DocumentPdfResult } from './generate-document-pdf';
import { manualReportBlockFromChecklist } from './manual-report';
import { CHECKLIST_VERSION } from '../validation/manual/checklist';
import { DOCUMENT_VERSION, type DocumentSpec } from './types';
import type { TableState } from './resolve-table';

const capturedAt = new Date('2026-10-02T12:00:00Z');
const icon = readFileSync(new URL('../../../public/favicon-16x16-cropped.png', import.meta.url));
const logoUrl = `data:image/png;base64,${icon.toString('base64')}`;
const locale = 'en-x-producer-proof';
const { registerLocale, setLocale } = translations;
// A producer inverse must fail its output assertions, not an absent new export.
const capturedCatalogue: { captureTranslation?: () => typeof translations.resolve } = translations;
const captureLabels = () => capturedCatalogue.captureTranslation?.() ?? translations.resolve;
afterEach(() => { cleanup(); setLocale('en'); });

function actualImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return Promise.resolve({ w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) });
}

async function publicInput(): Promise<DocumentPdfInput> {
  // Committed public SketchUp IFC; this is real parse/binding ground truth,
  // not a mock of a model or a schema-specific renderer oracle (#6660).
  const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  const walls = Array.from(store.entities.expressId).filter(id => store.entities.getTypeName(id) === 'IfcWall');
  assert.equal(walls.length, 4);
  const manual = manualReportBlockFromChecklist({ checklist: { version: CHECKLIST_VERSION, name: 'Public-model review',
    groups: [{ id: 'group', name: 'Delivery', items: [{ id: 'check', text: 'Review public model' }] }] },
    answers: { check: { status: 'pass', updatedAt: capturedAt.getTime() } }, now: capturedAt, modelName: 'building-architecture.ifc' }, 'manual');
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'producer', name: 'Shared producer',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [
      { kind: 'text', id: 'binding', style: 'body', text: 'Source {Model.Name}\nWalls {Count[IfcWall]}\n{{literal}}' },
      { kind: 'image', id: 'logo', dataUrl: logoUrl, height: 32, align: 'left' },
      { kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, maxRows: 2 },
      { kind: 'ids-report', id: 'information', sourceKind: 'rules', sourceName: 'Frozen information evidence',
        generatedAt: capturedAt.toISOString(), benchmarks: false, summary: { checked: 4, passed: 4, failed: 0, passRate: 100 }, checks: [] },
      manual,
    ] };
  return { document, bindings: { models: [{ id: 'public', name: 'building-architecture.ifc', store }], activeModelId: 'public', today: capturedAt },
    aggregations: new Map(), chartMessages: new Map(), topics: new Map(), snapshotIds: () => [],
    // A stated frozen validation-table invariant: the rows carry each real
    // wall's STEP identity; this test does not claim to run a validation rule.
    tables: new Map([['table', { status: 'ok', kind: 'validation', model: {
      columns: [{ id: 'rule', label: 'Rule', numeric: false }],
      rows: walls.map(id => ({ role: 'row', cells: [`Wall #${id}`] })), totalRows: walls.length,
    } }]]) };
}

async function actualPdf(input: DocumentPdfInput, beforeImageMeasure?: () => void) {
  const previous = Reflect.get(window, 'jspdf'); Reflect.set(window, 'jspdf', jspdf);
  let result: DocumentPdfResult;
  try {
    result = await generateDocumentPdf(input, { ...await browserReportSeams(null), now: () => capturedAt,
      imageSize: async dataUrl => { beforeImageMeasure?.(); return actualImageSize(dataUrl); } });
  } finally { Reflect.set(window, 'jspdf', previous); }
  const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const document = await task.promise; const pages = [];
    assert.equal(document.numPages, result.pages);
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const items = content.items.flatMap(item => 'str' in item ? [item] : []);
        const operators = await page.getOperatorList();
        pages.push({ number, items, text: items.map(item => item.str).join('\n'), height: page.view[3],
          images: operators.fnArray.filter(op => op === reader.OPS.paintImageXObject || op === reader.OPS.paintInlineImageXObject).length });
      } finally { page.cleanup(); }
    }
    return { result, pages };
  } finally { await task.destroy(); }
}

it('captures table/report/footer labels before actual PDF asset preparation and catalogue replacement (#6660)', async () => {
  registerLocale(locale, { 'document.print.footer': 'CAPTURED {timestamp}', 'document.print.pageCounter': 'LEAF {page} / {total}',
    'document.block.tableSourceValidation': 'Captured results', 'document.table.column.rule': 'Captured rule',
    'document.table.moreRows': 'Remaining captured {count}', 'document.preview.rulesReportHeading': 'Captured information {name}',
    'manualValidation.report.heading': 'Captured checklist {name}' });
  setLocale(locale);
  const input = await publicInput(); input.labels = captureLabels();
  const { result, pages } = await actualPdf(input, () => {
    registerLocale(locale, { 'document.print.footer': 'WRONG footer', 'document.print.pageCounter': 'WRONG counter',
      'document.table.column.rule': 'WRONG column', 'document.preview.rulesReportHeading': 'WRONG report' });
    setLocale('en');
  });
  assert.deepEqual(result.imageFailures, []); assert.deepEqual(result.tableFailures, []);
  assert.equal(pages.reduce((sum, page) => sum + page.images, 0), 1, 'real committed PNG reaches PDF bytes');
  const text = pages.map(page => page.text).join('\n');
  for (const expected of ['Source building-architecture.ifc', 'Walls 4', '{literal}', 'Captured results', 'Captured rule',
    'Remaining captured 2', 'Captured information Frozen information evidence', 'Captured checklist Public-model review']) {
    assert.ok(text.includes(expected), `actual PDF contains ${expected}`);
  }
  assert.ok(!text.includes('WRONG'));
  for (const page of pages) {
    assert.ok(page.text.includes('CAPTURED ')); assert.ok(page.text.includes(`LEAF ${page.number} / ${pages.length}`));
  }
});

// #6610/review4171484425: a printed report must not imply it updates itself.
it('uses the same static-report-safe missing-validation instruction in captured paper and PDF (#6610)', async () => {
  const expected = 'No validation report yet — run validation to include results.';
  const input = await publicInput();
  input.tables = new Map([['table', { status: 'no-report' }]]);
  setLocale('en'); input.labels = captureLabels();
  const printed = await actualPdf(input);
  assert.ok(printed.pages.map(page => page.text).join('\n').includes(expected), 'captured PDF has an instruction that does not promise live updates');
  const ui = render(createElement(DocumentPreview, { ...input, selectedBlockId: null, onSelectBlock: () => {} }));
  await waitFor(() => ui.querySelector('[data-preview-block="table"]') !== null && ui.querySelector('[data-layout-pending="true"]') === null,
    'actual missing-report paper preparation completes');
  assert.ok(ui.querySelector('[data-preview-block="table"]')?.textContent?.includes(expected), 'mounted paper uses the same instruction');
  cleanup();
  input.labels = undefined;
  const headless = await actualPdf(input);
  assert.ok(headless.pages.map(page => page.text).join('\n').includes(expected), 'omitted-label English PDF uses the same canonical instruction');
  registerLocale(locale, { 'document.table.noReport': 'Captured missing validation instruction' }); setLocale(locale);
  input.labels = captureLabels();
  const translated = await actualPdf(input, () => { registerLocale(locale, { 'document.table.noReport': 'WRONG later instruction' }); setLocale('en'); });
  const text = translated.pages.map(page => page.text).join('\n');
  assert.ok(text.includes('Captured missing validation instruction'), 'captured translated instruction survives actual PNG preparation');
  assert.ok(!text.includes('WRONG later instruction'));
});

it('keeps omitted-label PDF callers English and default heading geometry even with an active translated UI (#6660)', async () => {
  registerLocale(locale, { 'document.print.footer': 'WRONG footer', 'document.print.pageCounter': 'WRONG counter',
    'document.block.tableSourceValidation': 'WRONG title', 'document.table.column.rule': 'WRONG column' }); setLocale(locale);
  const { pages } = await actualPdf(await publicInput());
  const text = pages.map(page => page.text).join('\n');
  for (const expected of ['Validation results', 'Rule', 'Information validation report: Frozen information evidence', 'Manual validation: Public-model review']) {
    assert.ok(text.includes(expected), `canonical English: ${expected}`);
  }
  assert.ok(!text.includes('WRONG'));
  for (const page of pages) {
    assert.ok(page.text.includes(`Page ${page.number} / ${pages.length}`)); assert.ok(page.text.includes('Generated '));
    const title = page.items.find(item => item.str === 'Shared producer'); assert.ok(title);
    assert.equal(title.transform[0], 8); assert.ok(Math.abs(title.transform[4] - 40) < 0.01);
    assert.ok(Math.abs(page.height - title.transform[5] - 32) < 0.01);
  }
});

it('preserves every overflow source identity and wrapped unresolved field in the real public-model producer (#6660)', async () => {
  for (const scale of [1, 2]) {
    const input = await publicInput();
    input.document.blocks = [
      { kind: 'text', id: 'overflow', style: 'body', scale, text: Array.from({ length: 100 }, (_, index) => `Evidence ${index}`).join('\n') },
      { kind: 'text', id: 'field', style: 'body', scale, text: '{{literal}}\t{Count[IfcWall]}  {Model["missing.ifc"].Name}' },
      { kind: 'image', id: 'paired-image', dataUrl: logoUrl, height: 80, align: 'left', width: 'half', scale },
      { kind: 'text', id: 'paired-text', style: 'body', text: 'Paired source', width: 'half', scale },
    ];
    const diagnostic: Pick<DocumentPdfResult, 'unresolved' | 'missingTopics' | 'tableFailures'> = { unresolved: [], missingTopics: [], tableFailures: [] };
    const resolved = await resolveBlocks(input, actualImageSize, diagnostic);
    assert.equal(diagnostic.unresolved.length, 1, 'the actual missing model field is reported');
    const metrics = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    // The oracle uses the real standard-font metrics at the existing composer
    // boundary. No import of a newly added helper can mask inverse failures
    // behind MODULE_NOT_FOUND instead of the asserted behavior.
    const layout = composeDocument({ name: input.document.name, page: input.document.page, blocks: resolved, generatedAt: 'Captured',
      measure: (text, size, bold, font = 'helvetica') => {
        metrics.setFont(font, bold ? 'bold' : 'normal'); metrics.setFontSize(size); return metrics.getTextWidth(text);
      } });
    assert.ok(layout.pages.length >= 2);
    const allowed = new Set(input.document.blocks.map(block => block.id));
    for (const page of layout.pages) {
      assert.equal(page.blockIds?.length, page.items.length, 'source IDs align with the actual emitted item sequence');
      assert.ok(page.blockIds?.every(id => allowed.has(id)));
      assert.equal(layout.pageCounters?.[page.index], `Page ${page.index + 1} / ${layout.pages.length}`);
    }
    const items = layout.pages.flatMap(page => page.items.map((item, index) => ({ item, source: page.blockIds?.[index] })));
    const evidence = items.flatMap(({ item, source }) => source === 'overflow' && item.kind === 'text' ? [item.text] : []);
    assert.deepEqual(evidence, Array.from({ length: 100 }, (_, index) => `Evidence ${index}`), 'no continuation loses or invents a body line');
    const field = resolved.find(block => block.id === 'field'); assert.ok(field?.kind === 'text');
    const missing = field.bindingSpans?.find(span => !span.ok); assert.ok(missing);
    const marked = items.flatMap(({ item, source }) => source === 'field' && item.kind === 'text'
      ? (item.bindingMarks ?? []).filter(mark => mark.unresolved).map(mark => item.text.slice(mark.start, mark.end)) : []);
    assert.equal(marked.join('').replace(/\s/g, ''), field.text.slice(missing.start, missing.end).replace(/\s/g, ''),
      'wrapped unresolved glyph ranges keep exactly their original resolved source');
    assert.ok(items.some(({ item, source }) => source === 'paired-image' && item.kind === 'image'));
    assert.ok(items.some(({ item, source }) => source === 'paired-text' && item.kind === 'text' && item.text === 'Paired source'));
    const printed = await actualPdf(input);
    assert.equal(printed.pages.length, layout.pages.length, 'the actual PDF uses those same standard-font pages');
    assert.equal(printed.result.unresolved.length, 1);
    const pdfText = printed.pages.map(page => page.text).join('\n');
    for (let index = 0; index < 100; index++) assert.ok(pdfText.includes(`Evidence ${index}`), 'actual PDF keeps every overflow line');
  }
});

// Missing user-facing failure text must not resemble an empty successful table (#6610, review4171410340).
it('keeps failed table warnings visible in mounted paper and real PDF for blank captured translations (#6610)', async () => {
  const input = await publicInput();
  for (const control of [
    { translation: '', engine: '  ', expected: 'The list could not be run.' },
    { translation: '  \t ', engine: '', expected: 'The list could not be run.' },
    { translation: 'Captured failed list', engine: '', expected: 'Captured failed list' },
    { translation: '', engine: 'Real source failure', expected: 'Real source failure' },
  ]) {
    registerLocale(locale, { 'document.table.error': control.translation }); setLocale(locale);
    input.labels = captureLabels();
    input.tables = new Map([['table', { status: 'error', message: control.engine }]]);
    const ui = render(createElement(DocumentPreview, { ...input, selectedBlockId: null, onSelectBlock: () => {} }));
    await waitFor(() => ui.querySelector('[data-preview-block="table"]') !== null && ui.querySelector('[data-layout-pending="true"]') === null,
      'actual failed-table paper preparation completes');
    assert.ok(ui.querySelector('[data-preview-block="table"]')?.textContent?.includes(control.expected),
      `visible mounted failure: ${control.expected}`);
    const { result, pages } = await actualPdf(input);
    assert.deepEqual(result.imageFailures, [], 'actual committed PNG still exports');
    assert.ok(pages.map(page => page.text).join('\n').includes(control.expected), `actual PDF failure: ${control.expected}`);
    cleanup();
  }
});

// Blank captured catalogues must not hide any table diagnostic or source title.
it('keeps every unresolved and empty table status visible in mounted paper and real PDF for blank labels (#6610, review4172078887)', async () => {
  const input = await publicInput();
  const cases: { key: string; state: TableState; expected: string }[] = [
    { key: 'document.table.resolving', state: { status: 'resolving' }, expected: 'Running the list…' },
    { key: 'document.table.noModel', state: { status: 'no-model' }, expected: 'Load a model to fill this table.' },
    { key: 'document.table.noReport', state: { status: 'no-report' }, expected: 'No validation report yet — run validation to include results.' },
    { key: 'document.table.ruleNotFound', state: { status: 'rule-not-found' }, expected: 'The rule this table refers to is not in the current validation report.' },
    { key: 'document.table.noRows', state: { status: 'ok', kind: 'list', model: { title: 'Empty captured list', generatedAt: capturedAt.toISOString(), columns: [], groups: null, rows: [], groupColumnId: null, groupColumnIds: [], sumColumnIds: [], totals: { count: 0, sums: {} }, schedule: null } }, expected: 'No rows match this list.' },
    { key: 'document.table.validationNoRows', state: { status: 'ok', kind: 'validation', model: { columns: [], rows: [], totalRows: 0 } }, expected: 'No rows match this rule.' },
    { key: 'document.table.comparisonNoRows', state: { status: 'ok', kind: 'comparison', model: { columns: [], rows: [], totalRows: 0 } }, expected: 'No changes in this saved comparison.' },
  ];
  for (const blank of ['', '  \t ']) for (const control of cases) {
    registerLocale(locale, { [control.key]: blank, 'document.block.tableSourceValidation': blank }); setLocale(locale);
    input.labels = captureLabels(); input.tables = new Map([['table', control.state]]);
    const ui = render(createElement(DocumentPreview, { ...input, selectedBlockId: null, onSelectBlock: () => {} }));
    await waitFor(() => ui.querySelector('[data-preview-block="table"]') !== null && ui.querySelector('[data-layout-pending="true"]') === null,
      'actual blank-catalogue table preparation completes');
    const preview = ui.querySelector('[data-preview-block="table"]')?.textContent ?? '';
    assert.ok(preview.includes(control.expected), `mounted ${control.key}: ${blank}`);
    assert.ok(preview.includes('Validation results'), 'source title remains visible');
    const { pages } = await actualPdf(input); const printed = pages.map(page => page.text).join('\n');
    assert.ok(printed.includes(control.expected), `real PDF ${control.key}: ${blank}`);
    assert.ok(printed.includes('Validation results'), 'real PDF source title remains visible');
    cleanup();
  }
});
