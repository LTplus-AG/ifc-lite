/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as jspdf from 'jspdf';
import type { ColumnDefinition, ListDefinition, ListRow } from '@ifc-lite/lists';
import { act } from 'react';
import { registerLocale, setLocale, captureTranslation } from '@/i18n/registry';
import { render, cleanup, waitFor } from '@/test/render';
import { DocumentPreview } from '@/components/viewer/document/DocumentPreview';
import { buildExportModel } from '../lists/export/model';
import { browserReportSeams } from '../export/report/generate-report-pdf';
import { generateDocumentPdf, type DocumentPdfInput } from './generate-document-pdf';
import { DOCUMENT_VERSION, type IdsReportBlock } from './types';

const now = new Date('2026-10-02T12:00:00Z');
const png = readFileSync(new URL('../../../public/favicon-16x16-cropped.png', import.meta.url));
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
afterEach(() => { cleanup(); setLocale('en'); });

function declaredInput(): DocumentPdfInput {
  // Stated saved-document invariants, not invented validation engine results:
  // 1,004 list rows, and two frozen checks with large counts and a partial rule.
  const columns: ColumnDefinition[] = [{ id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'amount', source: 'attribute', propertyName: 'Amount' }];
  const rows: ListRow[] = Array.from({ length: 1004 }, (_, index) => ({ entityId: index + 1, modelId: 'declared', values: [`Record ${index + 1}`, 1] }));
  const list: ListDefinition = { id: 'list', name: 'Declared rows', createdAt: 0, updatedAt: 0, groups: [], entityTypes: [], columns };
  const model = buildExportModel({ title: list.name, columns, rows, numericCols: [false, true], columnWidths: [],
    grouping: { columnId: '', sumColumnIds: ['amount'] }, generatedAt: now.toISOString() });
  const report: IdsReportBlock = { kind: 'ids-report', id: 'classic', variant: 'long', sourceName: 'Declared checks',
    generatedAt: now.toISOString(), benchmarks: false, summary: { checked: 22344, passed: 19999, failed: 1111, warnings: 1234, passRate: 90 }, checks: [
      { id: 'warning', severity: 'warning', shortDescription: 'Declared warning', checked: 12345, passed: 11111, failed: 1234, passRate: 90,
        cardinality: { actual: 12345, min: 1234, max: 20000, passed: true },
        sets: [{ label: 'Authored measurements', actual: '1,234.50 m²', expected: '2,000.00 m²', passed: true }],
        rules: [{ id: 'complete', name: 'Complete', shortDescription: 'Complete', checked: 1234, passed: 1234, failed: 0, passRate: 100 },
          { id: 'partial', name: 'Partial', shortDescription: 'Partial', checked: 5678, passed: null, failed: null, passRate: null }] },
      { id: 'failure', shortDescription: 'Declared failure', checked: 9999, passed: 8888, failed: 1111, passRate: 89, rules: [] },
    ] };
  return { document: { version: DOCUMENT_VERSION, id: 'captured-numbers', name: 'Numeric capture', page: { size: 'A4', orientation: 'portrait' }, blocks: [
    { kind: 'image', id: 'logo', dataUrl, height: 16, align: 'left' },
    { kind: 'table', id: 'table', maxRows: 1, source: { kind: 'list', list } }, report,
    { ...report, id: 'compact', sourceKind: 'rules', variant: 'compact' },
  ] }, bindings: { models: [], activeModelId: null, today: now }, aggregations: new Map(), chartMessages: new Map(), topics: new Map(),
  tables: new Map([['table', { status: 'ok', kind: 'list', model }]]), snapshotIds: () => [] };
}

async function printed(input: DocumentPdfInput, duringImage?: () => void): Promise<string> {
  const previous = Reflect.get(window, 'jspdf'); Reflect.set(window, 'jspdf', jspdf);
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf(input, { ...await browserReportSeams(null), now: () => now,
      imageSize: async () => {
        duringImage?.(); await Promise.resolve();
        return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
      } });
  } finally { Reflect.set(window, 'jspdf', previous); }
  assert.deepEqual(result.imageFailures, [], 'real committed PNG reaches real jsPDF');
  const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const pdf = await task.promise; const text: string[] = [];
    assert.equal(pdf.numPages, result.pages);
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try { text.push(...(await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : [])); }
      finally { page.cleanup(); }
    }
    return text.join('\n');
  } finally { await task.destroy(); }
}

it('captures large table/IDS counts with the label locale through actual PNG preparation and catalogue replacement (#6610)', async () => {
  registerLocale('de', { 'document.table.moreRows': 'Rest {countDisplay}', 'document.table.total': 'Summe {count}',
    'document.preview.idsReportChecksCount': { one: '{countDisplay} Prüfung', other: '{countDisplay} Prüfungen' } });
  registerLocale('fr', { 'document.table.moreRows': 'WRONG {countDisplay}', 'document.table.total': 'WRONG {count}' });
  setLocale('de'); const input = declaredInput(); input.labels = captureTranslation();
  const ui = render(<DocumentPreview {...input} selectedBlockId={null} onSelectBlock={() => {}} />);
  await waitFor(() => ui.querySelector('[data-preview-block="compact"]') !== null && ui.querySelector('[data-layout-pending="true"]') === null,
    'actual mounted report and table finish preparation');
  const table = ui.querySelector('[data-preview-block="table"]'); assert.ok(table);
  assert.match(table.textContent ?? '', /Rest 1\.003/); assert.match(table.textContent ?? '', /Summe 1\.004/);
  const classic = ui.querySelector('[data-preview-block="classic"]'); assert.ok(classic);
  for (const value of ['22.344', '19.999', '1.111', '1.234', '12.345', '11.111', '5.678', '20.000', '2 Prüfungen']) {
    assert.ok(classic.textContent?.includes(value), `mounted report retains ${value}`);
  }
  const compact = ui.querySelector('[data-preview-block="compact"]'); assert.ok(compact);
  assert.ok(compact.textContent?.includes('1.234/1.234'), 'actual compact rule glyphs use the selected grouping');
  const text = await printed(input, () => act(() => {
    registerLocale('de', { 'document.table.moreRows': 'WRONG {countDisplay}', 'document.table.total': 'WRONG {count}' }); setLocale('fr');
  }));
  for (const expected of ['Rest 1.003', 'Summe 1.004', 'Checked 22.344', 'Passed 19.999', 'Failed 1.111', 'Warnings 1.234',
    'Checked 12.345', 'Passed 11.111', 'Checked 5.678', 'Found 12.345', '1.234 to 20.000', '1.234/1.234', '2 Prüfungen']) {
    assert.ok(text.includes(expected), `actual PDF retains captured ${expected}`);
  }
  for (const literal of ['1,234.50 m²', '2,000.00 m²', '90%', '100%']) assert.ok(text.includes(literal), `authored/rate value remains literal: ${literal}`);
  assert.ok(!text.includes('WRONG'));
});

it('preserves uncaptured English PDF counts and host-grouped table defaults despite an active German UI (#6610)', async () => {
  registerLocale('de', { 'document.table.moreRows': 'WRONG {countDisplay}', 'document.preview.idsReportChecked': 'WRONG' }); setLocale('de');
  const text = await printed(declaredInput());
  for (const expected of [`${(1003).toLocaleString()} more rows`, `Total (${(1004).toLocaleString()})`, 'Checked 22344',
    'Passed 19999', 'Checked 5678', 'Found 12345', '1234 to 20000', '1234/1234']) assert.ok(text.includes(expected), `old direct default: ${expected}`);
  assert.ok(!text.includes('Prüfungen') && !text.includes('WRONG'));
});
