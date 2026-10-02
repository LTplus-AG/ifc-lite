/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical-preview integration with shared headings and report stamps
 * (#6610, #6632, #6678). Read actual mounted glyphs and emitted jsPDF bytes.
 * The committed SketchUp sample supplies the chart and both validation engines;
 * manual answers and table rows below are explicitly authored document content. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as jspdf from 'jspdf';
import { IfcParser } from '@ifc-lite/parser';
import { aggregate, type ChartSpec } from '@ifc-lite/charts';
import { validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { Rule, runRuleSet, type RuleSetFile } from '@ifc-lite/rules';
import { registerLocale, setLocale } from '@/i18n';
import { captureTranslation } from '@/i18n/registry';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { installSvgCdataEnvironmentConversion } from '@/test/svg-cdata';
import { validationReportSnapshot } from '@/lib/validation/reports/history';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf, type DocumentPdfInput } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { pageBox } from '@/lib/export/report/compose';
import { DocumentPreview } from './DocumentPreview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setLocale('en'); useViewerStore.setState(original); });
const ink = '#1264c8', fill = '#f1c35a';
const now = new Date('2026-01-15T10:00:00.000Z');
const ids: IDSDocument = { info: { title: 'Public wall names' }, specifications: [{
  id: 'names', name: 'Wall Name exists', ifcVersions: ['IFC4'],
  applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
  requirements: [{ id: 'name', optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } } }],
}] };
const rules: RuleSetFile = { version: 1, name: 'Public wall information', rules: [{ id: 'plumbing', name: 'Name is plumbing wall',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('eq', 'plumbing wall')], combinator: 'AND' }], authoredAs: 'chips' } },
}] };

async function publicContent() {
  const bytes = readFileSync(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = { ...fixtureModel('public'), name: 'building-architecture.ifc', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), mutationVersion: 0 });
  const wallIds = Array.from(store.entities.expressId).filter(id => store.entities.getTypeName(id) === 'IfcWall');
  assert.equal(wallIds.length, 4);
  const reports = [await validateIDS(ids, createDataAccessor(store, model.id),
    { modelId: model.id, schemaVersion: store.schemaVersion, entityCount: store.entityCount }, { includePassingEntities: true }),
    await runRuleSet({ ruleSet: rules, models: evaluatorModelsFromState(useViewerStore.getState()), definedModelTagIds: new Set() })];
  assert.deepEqual(reports.map(report => [report.summary.totalEntitiesChecked, report.summary.totalEntitiesPassed]), [[4, 4], [4, 1]]);
  const chart: ChartSpec = { id: 'classes', title: 'Public walls', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } };
  const aggregation = aggregate(chart, { source: 'elements', columns: [{ id: 'IfcType', label: 'IFC class', kind: 'category' }],
    rows: wallIds.map(id => ({ ids: [id], values: [store.entities.getTypeName(id)] })), fingerprint: 'actual-public-walls' });
  const manual = manualReportBlockFromChecklist({ checklist: { version: CHECKLIST_VERSION, name: 'Authored checklist',
    groups: [{ id: 'g', name: 'Review', items: [{ id: 'a', text: 'Review the drawing' }] }] },
    answers: { a: { status: 'pass', updatedAt: now.getTime() } }, now, modelName: model.name }, 'manual');
  return { chart, aggregation, manual, model, store,
    reportBlocks: reports.map(report => ({ ...validationReportSnapshot(report, useViewerStore.getState().models, report.source.kind),
      variant: 'compact' as const, benchmarks: false })) };
}

function documentOf(blocks: DocumentBlock[], id = 'union'): DocumentSpec {
  return { version: DOCUMENT_VERSION, id, name: 'Shared canonical headings and stamps', page: { size: 'A4', orientation: 'portrait' }, blocks };
}
function mount(input: DocumentPdfInput) {
  return render(<DocumentPreview {...input} selectedBlockId={null} onSelectBlock={() => {}} />);
}
function glyph(root: Element, text: string): HTMLElement {
  const node = Array.from(root.querySelectorAll<HTMLElement>('span')).find(el => el.children.length === 0 && el.textContent?.trim() === text);
  assert.ok(node, `actual composed glyph: ${text}`); return node;
}

function samePdfFill(actual: string, authored: string): boolean {
  // Two-decimal normalized RGB plus 8-bit decoding rounds by at most 1.775.
  return [1, 3, 5].every(offset =>
    Math.abs(parseInt(actual.slice(offset, offset + 2), 16) - parseInt(authored.slice(offset, offset + 2), 16)) <= 2);
}

async function emitted(input: DocumentPdfInput) {
  // Environment-only conversion of actual ECharts CDATA: strict XML / native
  // browser SVG output is unchanged. svg2pdf's Node UMD needs real jsPDF on window.
  const restore = installSvgCdataEnvironmentConversion();
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const prior = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try { result = await generateDocumentPdf(input, { ...await browserReportSeams(null), imageSize: browserImageSize }); }
  finally { restore(); pdfWindow.jspdf = prior; }
  const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  const text: Array<{ str: string; size: number; x: number; y: number; page: number }> = [];
  const fills: string[] = []; let images = 0;
  try {
    const pdf = await task.promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), content = await page.getTextContent(), ops = await page.getOperatorList();
      for (const item of content.items) if ('str' in item) text.push({ str: item.str, size: item.transform[0], x: item.transform[4], y: item.transform[5], page: n });
      ops.fnArray.forEach((op, index) => {
        if (op === reader.OPS.setFillRGBColor) fills.push(ops.argsArray[index][0]);
        if (op === reader.OPS.paintImageXObject) images++;
      });
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return { result, text, fills, images };
}

it('keeps authored heading ink, backing strips and measured glyph positions in the canonical preview and actual PDF for all supported kinds (#6610, #6632)', async () => {
  const content = await publicContent();
  // Real committed PNG, decoded by jsPDF; Happy DOM natural-size fallback is
  // the same shared fallback used by the mounted preview and browser seam.
  const png = `data:image/png;base64,${readFileSync(new URL('../../../../public/favicon-48x48-cropped.png', import.meta.url)).toString('base64')}`;
  const authored: DocumentBlock[] = [
    { kind: 'text', id: 'text', style: 'body', text: 'Authored body' },
    { kind: 'image', id: 'image', dataUrl: png, height: 30, align: 'left' },
    { kind: 'chart', id: 'chart', chart: content.chart, height: 90, snapshot: false },
    { kind: 'topic', id: 'topic', guid: 'coordination', snapshot: false },
    { kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] } },
    ...content.reportBlocks, content.manual,
  ];
  const blocks = authored.map(block => ({ ...block, title: `Heading ${block.id}`, titleFontSize: 20, titleTextColor: ink, titleBackgroundColor: fill, scale: 1.5 }));
  const document = documentOf(blocks);
  const input: DocumentPdfInput = { document, bindings: { models: [], activeModelId: null, today: now },
    aggregations: new Map([['chart', content.aggregation]]), chartMessages: new Map(), snapshotIds: () => [],
    topics: new Map([['coordination', { guid: 'coordination', title: 'Coordination', description: 'Authored topic', viewpoints: [], comments: [] }]]),
    tables: new Map([['table', { status: 'ok', kind: 'validation', model: { columns: [{ label: 'Rule', numeric: false }],
      rows: [{ role: 'row', cells: ['Authored table row'] }], totalRows: 1 } }]]) };
  const ui = mount(input); await documentPreviewReady();
  const pdf = await emitted(input); assert.equal(pdf.result.imageFailures.length, 0); assert.ok(pdf.images > 0, 'the real PNG is emitted as an image');
  assert.ok(pdf.text.some(item => item.str === 'IfcWall'), 'the chart contains actual public IFC classes');
  const k = 560 / pageBox(document.page).w;
  for (const block of blocks) {
    const heading = glyph(ui, `Heading ${block.id}`), group = heading.closest<HTMLElement>('[data-preview-block]'); assert.ok(group);
    const strip = Array.from(group.querySelectorAll<HTMLElement>('[aria-hidden="true"]')).find(node => node.style.backgroundColor === fill); assert.ok(strip);
    assert.equal(heading.style.color, ink); assert.ok(Math.abs(parseFloat(heading.style.fontSize) - 30 * k) < 0.01);
    assert.ok(parseFloat(strip.style.height) >= parseFloat(heading.style.fontSize));
    const printed = pdf.text.find(item => item.str === `Heading ${block.id}`); assert.ok(printed);
    assert.ok(Math.abs(printed.size - 30) < 0.01, `${block.kind}: actual PDF font`);
    const x = (parseFloat(group.style.left) + parseFloat(heading.style.left)) / k;
    const baseline = (parseFloat(group.style.top) + parseFloat(heading.style.top) + parseFloat(heading.style.fontSize)) / k;
    assert.ok(Math.abs(printed.x - x) < 0.05, `${block.kind}: same measured x`);
    assert.ok(Math.abs(pageBox(document.page).h - printed.y - baseline) < 0.05, `${block.kind}: same measured baseline`);
  }
  assert.ok(pdf.fills.includes(ink), 'real PDF operators retain the explicit heading ink');
  // jsPDF writes numeric fills to two decimal places in normalized RGB. The
  // actual PDF command 0.95 0.76 0.35 rg independently decodes to #f2c259 for
  // authored #f1c35a: bound encoding + 8-bit rounding to two values per channel.
  // Preview colours remain exact, as do the glyph/font/coordinate checks above.
  assert.ok(pdf.fills.filter(actual => samePdfFill(actual, fill)).length >= blocks.length,
    'every actual heading strip has a PDF backing fill within bounded RGB encoding precision');
});

it('shows or removes captured report stamps for actual IDS/information results and authored manual evidence without reserving hidden rows (#6610, #6678)', async () => {
  const content = await publicContent();
  registerLocale('de-x-stamp-union', { 'document.preview.idsReportGeneratedAt': 'Erfasst {timestamp}',
    'validationPanel.history.models': 'Modelle {models}', 'manualValidation.report.recordedAtModel': 'Erfasst {timestamp} am {model}',
    'manualValidation.report.recordedAt': 'Erfasst {timestamp}' });
  setLocale('de-x-stamp-union'); const labels = captureTranslation(); setLocale('en');
  for (const source of [...content.reportBlocks, { ...content.manual, benchmarks: false }]) {
    let shownCheckY = 0;
    for (const showStamp of [undefined, false]) {
      const document = documentOf([{ ...source, showStamp, title: 'Frozen evidence' }], `stamp-${source.id}-${showStamp}`);
      const input: DocumentPdfInput = { document, labels, bindings: { models: [], activeModelId: null, today: new Date('2099-01-01') },
        aggregations: new Map(), chartMessages: new Map(), tables: new Map(), topics: new Map(), snapshotIds: () => [] };
      const ui = mount(input); await documentPreviewReady(); const pdf = await emitted(input);
      const text = pdf.text.map(item => item.str), preview = ui.textContent ?? '';
      const stamp = text.find(line => line.startsWith('Erfasst '));
      assert.equal(Boolean(stamp), showStamp !== false); assert.equal(preview.includes('Erfasst '), showStamp !== false);
      if (stamp) { assert.ok(stamp.includes(source.generatedAt), 'actual frozen time, not the live binding date'); assert.ok(preview.includes(source.generatedAt)); }
      if (source.kind === 'ids-report') {
        assert.equal(text.some(line => line.startsWith('Modelle ')), showStamp !== false);
        assert.equal(preview.includes('Modelle building-architecture.ifc'), showStamp !== false);
      }
      const check = source.kind === 'ids-report' ? source.checks[0].shortDescription : 'Review the drawing';
      const printed = pdf.text.find(item => item.str === check); assert.ok(printed); glyph(ui, check);
      if (showStamp === undefined) shownCheckY = printed.y;
      else assert.ok(printed.y > shownCheckY + 10, 'hiding metadata removes actual body height in the PDF');
      const heading = glyph(ui, 'Frozen evidence');
      assert.ok(Math.abs(parseFloat(heading.style.fontSize) / (560 / pageBox(document.page).w) - 11) < 0.01, 'omitted appearance retains the default heading size');
      assert.equal(pdf.fills.some(actual => samePdfFill(actual, fill)), false, 'omitted appearance adds no heading strip');
      assert.equal(source.showStamp, undefined, 'presentation did not mutate the recorded source');
      cleanup();
    }
  }
});
