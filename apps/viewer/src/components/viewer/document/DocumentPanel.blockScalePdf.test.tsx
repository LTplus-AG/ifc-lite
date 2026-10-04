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
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import * as jspdf from 'jspdf';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { aggregate, type ChartSpec } from '@ifc-lite/charts';
import { cleanup, render } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { installSvgCdataEnvironmentConversion } from '@/test/svg-cdata';
import { pageBox } from '@/lib/export/report/compose';
import { DocumentPreview } from './DocumentPreview';
import { dirname, join } from 'node:path';
import { generateDocumentPdf, browserImageSize } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';

afterEach(cleanup);

const state = { status: 'ok' as const, kind: 'validation' as const, model: {
  columns: [{ label: 'Rule', numeric: false }],
  rows: [{ role: 'row' as const, cells: ['Row one'] }, { role: 'row' as const, cells: ['Row two'] }],
  totalRows: 2,
} };

async function tableText(scale?: number): Promise<Array<{ str: string; size: number; baseline: number; left: number }>> {
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'table', id: 'tb', ...(scale ? { scale } : {}), source: { kind: 'validation', rows: 'failed', columns: ['rule'] } }] };
  // svg2pdf's Node UMD entry looks for its jsPDF dependency on the DOM window.
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const prior = pdfWindow.jspdf;
  pdfWindow.jspdf = jspdf;
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date('2026-10-01') },
      aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map([['tb', state]]), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: browserImageSize });
  } finally { pdfWindow.jspdf = prior; }
  return (await pdfText(result.blob)).filter(item => item.str.startsWith('Row'));
}

async function pdfText(blob: Blob): Promise<Array<{ str: string; size: number; baseline: number; left: number }>> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), enableXfa: false, stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    return content.items.flatMap((item) => ('str' in item ? [{ str: item.str, size: item.transform[0], baseline: item.transform[5], left: item.transform[4] }] : []));
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
  // The cell padding grows with the block too: the text starts one padding in from the table's left edge.
  assert.ok(Math.abs((one[0].left - 40) - 2) < 0.1, `padding at 1x is ${one[0].left - 40}`);
  assert.ok(Math.abs((two[0].left - 40) - 4) < 0.1, `padding at 2x is ${two[0].left - 40}`);
});

it('places scaled table cells at the same font factor as the actual PDF (#6548, #6660)', async () => {
  for (const factor of [1, 2]) {
    const document: DocumentSpec = { version: DOCUMENT_VERSION, id: `table-${factor}`, name: 'Table scale',
      page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'table', id: 'tb', scale: factor,
        source: { kind: 'validation', rows: 'failed', columns: ['rule'] } }] };
    const ui = render(<DocumentPreview document={document} bindings={{ models: [], activeModelId: null, today: new Date('2026-10-01') }}
      aggregations={new Map()} chartMessages={new Map()} topics={new Map()} tables={new Map([['tb', state]])}
      selectedBlockId={null} onSelectBlock={() => {}} />);
    await documentPreviewReady();
    const table = ui.querySelector<HTMLTableElement>('[data-preview-block="tb"] table'); assert.ok(table);
    const cell = table.querySelector<HTMLTableCellElement>('tbody td'); assert.ok(cell);
    const printed = await tableText(factor);
    const pageScale = 560 / pageBox(document.page).w;
    assert.ok(Math.abs(parseFloat(table.style.fontSize) - printed[0].size * pageScale) < 0.01, 'actual preview and PDF table type scale together');
    assert.ok(Math.abs(parseFloat(cell.style.padding) - 2 * factor * pageScale) < 0.01, 'cell padding scales with its text');
    assert.deepEqual(Array.from(table.querySelectorAll('tbody td')).map(node => node.textContent), ['Row one', 'Row two']);
    cleanup();
  }
});

it('prints a scaled public-model chart with the same enlarged plot labels as its composed preview (#6548, #6660)', async () => {
  // Read the real SketchUp sample; the aggregation is formed from its actual IFC classes.
  const bytes = readFileSync(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const ids = Array.from(store.entities.expressId).filter(id => ['IfcWall', 'IfcDoor'].includes(store.entities.getTypeName(id)));
  assert.equal(ids.filter(id => store.entities.getTypeName(id) === 'IfcWall').length, 4);
  const chart: ChartSpec = { id: 'public-classes', title: 'Public IFC classes', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } };
  const aggregation = aggregate(chart, { source: 'elements', columns: [{ id: 'IfcType', label: 'IFC class', kind: 'category' }],
    rows: ids.map(id => ({ ids: [id], values: [store.entities.getTypeName(id)] })), fingerprint: 'public-source-classes' });
  const printedSizes: number[] = [];
  const restoreParser = installSvgCdataEnvironmentConversion();
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const prior = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
  try {
    for (const factor of [1, 2]) {
      const document: DocumentSpec = { version: DOCUMENT_VERSION, id: `chart-${factor}`, name: 'Public chart scale',
        page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'chart', id: 'chart', chart, scale: factor, height: 150, snapshot: false }] };
      const input = { document, bindings: { models: [], activeModelId: null, today: new Date('2026-10-01') },
        aggregations: new Map([['chart', aggregation]]), chartMessages: new Map<string, string>(), topics: new Map(), tables: new Map(), snapshotIds: () => [] };
      const ui = render(<DocumentPreview {...input} selectedBlockId={null} onSelectBlock={() => {}} />);
      await documentPreviewReady();
      const svg = ui.querySelector<SVGSVGElement>('[data-chart-svg] svg'); assert.ok(svg);
      const label = Array.from(svg.querySelectorAll('text')).find(node => node.textContent === 'IfcWall'); assert.ok(label);
      const authoredFontSize = parseFloat(label.style.fontSize); assert.ok(authoredFontSize > 0);
      const result = await generateDocumentPdf(input, { ...await browserReportSeams(null), imageSize: browserImageSize });
      const printed = (await pdfText(result.blob)).find(item => item.str === 'IfcWall'); assert.ok(printed);
      assert.ok(Math.abs(printed.size - authoredFontSize * factor) < 0.1, 'real svg2pdf operator scales the unchanged SVG label by the block factor');
      printedSizes.push(printed.size);
      const frame = svg.parentElement; assert.ok(frame);
      const pageScale = 560 / pageBox(document.page).w;
      assert.ok(Math.abs(parseFloat(frame.style.height) - Number(svg.getAttribute('height')) * factor * pageScale) < 0.01);
      cleanup();
    }
    assert.ok(Math.abs(printedSizes[1] - printedSizes[0] * 2) < 0.1, 'doubling the block doubles its actual PDF plot label');
  } finally { restoreParser(); pdfWindow.jspdf = prior; }
});
