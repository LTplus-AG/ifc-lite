/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { act } from 'react';
import * as jspdf from 'jspdf';
import { IfcParser } from '@ifc-lite/parser';
import { registerLocale, setLocale } from '@/i18n';
import { validateIDS, type IDSDocument, type ValidationReport } from '@ifc-lite/ids';
import { Rule, runRuleSet, type RuleSetFile } from '@ifc-lite/rules';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { browserImageSize, generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { layoutIdsReport } from '@/lib/document/compose-ids-report';
import type { LayoutCursor, TextDrawnItem, TableDrawnItem, RectDrawnItem } from '@/lib/document/compose-table';
import type { RingDrawnItem } from '@/lib/document/compose-manual-report';
import { composeDocument, estimateTextWidth, truncateToWidth, wrapText } from '@/lib/document/compose';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { validationReportSnapshot } from '@/lib/validation/reports/history';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { RING_COLORS } from '@/lib/validation/manual/ring';
import { REPORT_MARGIN } from '@/lib/export/report/compose';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click, type as typeInput } from '@/test/render';
import { ValidationPanel } from '../validation/ValidationPanel';
import { DocumentPanel } from './DocumentPanel';

// SketchUp 2024's committed public model has four walls; exactly one is
// named "plumbing wall". Both engines evaluate these actual entities (#6552).
const ids: IDSDocument = { info: { title: 'Public wall name checks' }, specifications: [
  { id: 'names', name: 'Wall Name exists', ifcVersions: ['IFC4'],
    applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
    requirements: [{ id: 'name', optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } } }] },
  { id: 'plumbing', name: 'Wall Name is plumbing wall', ifcVersions: ['IFC4'],
    applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
    requirements: [{ id: 'name', optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' }, value: { type: 'simpleValue', value: 'plumbing wall' } } }] },
] };
const applicability = { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' as const }], authoredAs: 'chips' as const };
const rules: RuleSetFile = { version: 1, name: 'Public wall information checks', rules: [
  { id: 'description', name: 'Description exists', applicability,
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Description', 'isSet', '')], combinator: 'AND' }], authoredAs: 'chips' } } },
  { id: 'plumbing', name: 'Name is plumbing wall', applicability,
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('eq', 'plumbing wall')], combinator: 'AND' }], authoredAs: 'chips' } } },
  { id: 'warning', name: 'Description mentions plumbing', applicability, severity: 'warning',
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Description', 'contains', 'plumbing')], combinator: 'AND' }], authoredAs: 'chips' } } },
] };
const original = useViewerStore.getState();
let reports: ValidationReport[];
let spec: DocumentSpec;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(async () => {
  localStorage.clear(); setValidationSourceChoice(null);
  const bytes = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = { ...fixtureModel('m'), name: 'building-architecture.ifc', sourceFingerprint: 'public-sketchup-4-walls', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(model), documents: [], activeDocumentId: null, mutationViews: new Map(), mutationVersion: 0,
    idsDocument: null, idsValidationReport: null, validationSource: null, savedValidationReports: [], validationReportsLoadIssue: null });
  reports = [await validateIDS(ids, createDataAccessor(store, model.id),
    { modelId: model.id, schemaVersion: store.schemaVersion, entityCount: store.entityCount }, { includePassingEntities: true }),
    await runRuleSet({ ruleSet: rules, models: evaluatorModelsFromState(useViewerStore.getState()), definedModelTagIds: new Set() })];
  assert.deepEqual(reports.map((report) => [report.summary.totalEntitiesChecked, report.summary.totalEntitiesPassed, report.summary.totalEntitiesFailed]), [[8, 5, 3], [12, 6, 6]]);
  spec = { version: DOCUMENT_VERSION, id: 'benchmarks', name: 'Actual validation benchmarks', page: { size: 'A4', orientation: 'portrait' },
    blocks: reports.flatMap((report) => (['compact', 'long'] as const).map((variant) => ({
      ...validationReportSnapshot(report, useViewerStore.getState().models, `${report.source.kind}-${variant}`), variant,
    }))) };
  useViewerStore.setState({ documents: [spec], activeDocumentId: spec.id });
});
afterEach(() => { cleanup(); setLocale('en'); setValidationSourceChoice(null); useViewerStore.setState(original); });

/** Assert actual rendered SVG arc shares against engine outcomes, rather
 * than asserting a helper/mock's return value or pinning the SVG bytes. */
function assertRing(root: Element, report: ValidationReport): void {
  const benchmark = root.querySelector('[data-validation-benchmark]'); assert.ok(benchmark, `${report.source.kind} renders its benchmark`);
  const image = benchmark.querySelector('img'); assert.ok(image);
  const uri = image.getAttribute('src'); assert.ok(uri && uri.startsWith('data:image/svg+xml'));
  const svg = new window.DOMParser().parseFromString(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)), 'image/svg+xml');
  const track = svg.querySelector('circle'); assert.ok(track);
  const circumference = 2 * Math.PI * Number(track.getAttribute('r'));
  const warnings = report.source.kind === 'rules' ? report.specificationResults.reduce((n, check) => n + (check.specification.severity === 'warning' ? check.failedCount : 0), 0) : 0;
  const expected = { pass: report.summary.totalEntitiesPassed, warning: warnings, fail: report.summary.totalEntitiesFailed - warnings };
  const present = Object.values(expected).filter((n) => n > 0).length;
  const size = Number(svg.documentElement.getAttribute('width'));
  const arcs = [...svg.querySelectorAll('path')];
  assert.equal(arcs.length, present > 1 ? present : 0);
  const angle = (x: number, y: number) => (Math.atan2(x - size / 2, size / 2 - y) + 2 * Math.PI) % (2 * Math.PI);
  let start = 0;
  for (const [bucket, count] of Object.entries(expected)) {
    if (count === 0) continue;
    const color = RING_COLORS[bucket as 'pass' | 'warning' | 'fail'];
    if (present === 1) {
      const circle = [...svg.querySelectorAll('circle')].find((entry) => entry.getAttribute('stroke') === color); assert.ok(circle, 'a single outcome is a complete circle');
      continue;
    }
    const arc = arcs.find((entry) => entry.getAttribute('stroke') === color); assert.ok(arc, `${bucket} has its own visible arc`);
    const values = arc.getAttribute('d')?.match(/^M ([^ ]+) ([^ ]+) A ([^ ]+) ([^ ]+) 0 ([01]) 1 ([^ ]+) ([^ ]+)$/); assert.ok(values, 'each segment is an actual clockwise circular arc');
    const [sx, sy, rx, ry, large, ex, ey] = values.slice(1).map(Number);
    assert.equal(rx, Number(track.getAttribute('r'))); assert.equal(ry, rx);
    const from = angle(sx, sy), to = angle(ex, ey);
    assert.ok(Math.abs(from - start) < 1e-8, 'bucket order starts at twelve o’clock and follows the engine outcome order clockwise');
    const span = (to - from + 2 * Math.PI) % (2 * Math.PI);
    assert.equal(large, span > Math.PI ? 1 : 0);
    assert.ok(Math.abs((span * rx + Math.max(1, size / 40)) / circumference - count / report.summary.totalEntitiesChecked) < 1e-8, `${bucket} visible angular share plus its gap reflects actual checked-entity share`);
    start += count / report.summary.totalEntitiesChecked * 2 * Math.PI;
  }
  assert.ok(image.getAttribute('alt')?.includes(`${report.summary.overallPassRate}%`), 'accessible label retains the engine pass rate');
  assert.ok(benchmark.textContent?.includes(`${report.summary.overallPassRate}%`), 'visible rate retains the engine rounding');
}

describe('IDS and information-validation ring benchmarks (#6552)', () => {
  it('renders both real engine outcomes in the shared live results panel without saving or changing the evidence', async () => {
    for (const report of reports) {
      act(() => {
        useViewerStore.setState({ idsDocument: report.source.kind === 'ids' ? ids : null,
          validationRuleSetDraft: report.source.kind === 'rules' ? rules : null, validationRuleSetEditing: false });
        useViewerStore.getState().setIdsValidationReport(report, validationReportSnapshot(report, useViewerStore.getState().models, 'live'));
        setValidationSourceChoice(report.source.kind);
      });
      const ui = render(<ValidationPanel />); await settle();
      assertRing(ui, report);
      assert.equal(useViewerStore.getState().idsValidationReport, report, 'benchmark display does not replace the actual engine report');
      assert.equal(useViewerStore.getState().savedValidationReports.length, 0, 'displaying the result does not save it');
      cleanup();
    }
  });

  it('edits persisted benchmark controls for both sources and both report variants, preserving old output and matching the canonical PDF layout counts', async () => {
    const old = parseDocumentFile(JSON.stringify({ ...spec, blocks: spec.blocks.map((block) => block.kind === 'ids-report' ? { ...block, variant: undefined } : block) }));
    const oldLayout = composeDocument({ name: old.name, page: old.page, generatedAt: '', measure: estimateTextWidth, blocks: old.blocks.filter((block) => block.kind === 'ids-report') });
    assert.equal(oldLayout.pages.flatMap((page) => page.items).filter((item) => item.kind === 'ring').length, 0, 'existing documents add no benchmark rings');
    const ui = render(<DocumentPanel />); await settle();
    for (const block of spec.blocks) {
      assert.ok(block.kind === 'ids-report');
      const editor = ui.querySelector(`[data-block-editor="${block.id}"]`); assert.ok(editor);
      const label = [...editor.querySelectorAll('label')].find((entry) => entry.textContent?.includes('Show benchmark scores'));
      const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(input, 'the report exposes an actual persisted benchmark control');
      assert.equal(input.checked, false, 'old embedded reports keep the existing default');
      click(input); await settle();
      const preview = ui.querySelector(`[data-preview-block="${block.id}"]`); assert.ok(preview);
      assertRing(preview, reports.find((report) => report.source.kind === block.sourceKind)!);
    }
    const saved = loadDocuments().find((document) => document.id === spec.id); assert.ok(saved);
    const imported = parseDocumentFile(JSON.stringify(saved));
    const blocks = imported.blocks.filter((block) => block.kind === 'ids-report');
    const layout = composeDocument({ name: imported.name, page: imported.page, generatedAt: '', measure: estimateTextWidth, blocks });
    const rings = layout.pages.flatMap((page) => page.items).filter((item) => item.kind === 'ring');
    assert.equal(rings.length, 4);
    assert.deepEqual(rings.map((ring) => ring.counts), [
      { total: 8, pass: 5, warning: 0, fail: 3, unanswered: 0 }, { total: 8, pass: 5, warning: 0, fail: 3, unanswered: 0 },
      { total: 12, pass: 6, warning: 3, fail: 3, unanswered: 0 }, { total: 12, pass: 6, warning: 3, fail: 3, unanswered: 0 },
    ], 'PDF rings retain every engine outcome and keep warnings out of failure counts');
    cleanup(); act(() => useViewerStore.setState({ documents: [imported], activeDocumentId: imported.id }));
    const reopened = render(<DocumentPanel />); await settle();
    for (const block of blocks) {
      const preview = reopened.querySelector(`[data-preview-block="${block.id}"]`); assert.ok(preview);
      assertRing(preview, reports.find((report) => report.source.kind === block.sourceKind)!);
      assert.ok(preview.textContent?.includes(block.sourceName), 'source heading remains independent of benchmark presentation');
    }
  });
  it('retains the engine cardinality verdict and empty/partial evidence instead of deriving a new pass percentage from the ring', async () => {
    const model = useViewerStore.getState().models.get('m'); assert.ok(model?.ifcDataStore);
    const variants: IDSDocument[] = [
      { ...ids, specifications: [{ ...ids.specifications[0], minOccurs: 5 }] },
      { ...ids, specifications: [{ ...ids.specifications[0], applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCPIPESEGMENT' } }] } }] },
      ids,
    ];
    for (const [i, definition] of variants.entries()) {
      const report = await validateIDS(definition, createDataAccessor(model.ifcDataStore, model.id),
        { modelId: model.id, schemaVersion: model.ifcDataStore.schemaVersion, entityCount: model.ifcDataStore.entityCount }, { includePassingEntities: false });
      assert.equal(report.summary.overallPassRate, [0, 100, 62][i]);
      const block = { ...validationReportSnapshot(report, useViewerStore.getState().models, 'edge'), benchmarks: true };
      assert.ok(block.kind === 'ids-report');
      if (i === 0) assert.equal(block.summary.passed, 4, 'four individually passing walls do not erase a failed minimum cardinality');
      if (i === 1) assert.equal(block.summary.checked, 0, 'the actual model has no matching pipe segment');
      if (i === 2) assert.ok(block.checks.some((check) => check.rules.some((rule) => rule.passRate === null)), 'passing entity details really were omitted');
      act(() => useViewerStore.setState({ documents: [{ ...spec, blocks: [block] }], activeDocumentId: spec.id }));
      const ui = render(<DocumentPanel />); await settle(); assertRing(ui, report);
      const layout = composeDocument({ name: spec.name, page: spec.page, generatedAt: '', measure: estimateTextWidth, blocks: [block] });
      assert.ok(layout.pages.flatMap((page) => page.items).some((item) => item.kind === 'text' && item.text.includes(`${report.summary.overallPassRate}% passed`)), 'PDF states the same bounded engine verdict');
      cleanup();
    }
  });

  it('rejects malformed imported controls, lets the user hide a ring, and retranslates visible labels without changing frozen evidence', async () => {
    assert.throws(() => parseDocumentFile(JSON.stringify({ ...spec, blocks: [{ ...spec.blocks[0], benchmarks: 'yes' }] })), /benchmarks/);
    const block = { ...spec.blocks[0], benchmarks: true }; assert.ok(block.kind === 'ids-report');
    act(() => useViewerStore.setState({ documents: [{ ...spec, blocks: [block] }], activeDocumentId: spec.id }));
    const ui = render(<DocumentPanel />); await settle(); assertRing(ui, reports[0]);
    registerLocale('de-x-rings', { 'manualValidation.report.benchmarks': 'Ring anzeigen', 'manualValidation.verdict.pass': 'Bestanden',
      'manualValidation.verdict.fail': 'Fehler', 'document.preview.idsReportPassRate': 'Prüfquote',
      'manualValidation.ring.label': '{name}: {pass} bestanden, {warning} Warnungen, {fail} Fehler, {unanswered} offen' });
    act(() => setLocale('de-x-rings')); await settle();
    assert.ok(ui.textContent?.includes('Bestanden'));
    assert.ok(ui.querySelector('[data-validation-benchmark] img')?.getAttribute('alt')?.includes('Prüfquote 62%'));
    const label = [...ui.querySelectorAll('label')].find((entry) => entry.textContent?.includes('Ring anzeigen'));
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(input); click(input); await settle();
    assert.equal(ui.querySelector('[data-validation-benchmark]'), null);
    const saved = loadDocuments().find((doc) => doc.id === spec.id); assert.ok(saved);
    assert.deepEqual(saved.blocks[0], JSON.parse(JSON.stringify({ ...block, benchmarks: false })), 'hiding the ring preserves all serializable frozen source numbers and identifiers');
    const printed = composeDocument({ name: spec.name, page: spec.page, generatedAt: '', measure: estimateTextWidth, blocks: saved.blocks.filter((entry) => entry.kind === 'ids-report') });
    assert.equal(printed.pages.flatMap((page) => page.items).filter((item) => item.kind === 'ring').length, 0);
  });

  it('keeps ring geometry and measured summary text inside a narrow layout cursor when the preceding content crosses a page boundary', () => {
    // The composer supplies this same cursor contract to its report renderer.
    // A narrow frame verifies ring/label reservation independently of page size.
    const width = 220, left = 40, top = 70, bottom = 420;
    let page = 0;
    type Drawn = TextDrawnItem | TableDrawnItem | RectDrawnItem | RingDrawnItem;
    const drawn: Array<{ page: number; item: Drawn }> = [];
    const cursor: LayoutCursor = { x: left, y: bottom - 20, top, bottom,
      newPage() { page++; this.y = top; },
      ensure(height) { if (this.y + height > bottom && this.y > top) this.newPage(); },
      push(...items) { for (const item of items) drawn.push({ page, item }); },
      truncate: (text, max, size, bold) => truncateToWidth(text, max, size, bold, estimateTextWidth),
    };
    for (const block of spec.blocks) {
      assert.ok(block.kind === 'ids-report');
      layoutIdsReport({ ...block, benchmarks: true }, cursor, width, 10,
        (text, max, size, bold) => wrapText(text, max, size, bold, estimateTextWidth), (item) => drawn.push({ page, item }));
    }
    assert.ok(page > 1, 'actual report rows really cross page boundaries');
    assert.equal(drawn.filter(({ item }) => item.kind === 'ring').length, 4);
    for (const { item } of drawn) {
      assert.ok(item.y >= top && item.y <= bottom, 'every item begins inside the content frame');
      if (item.kind === 'ring') assert.ok(item.y + item.size <= bottom && item.x + item.size <= left + width, 'ring remains inside its page column');
      if (item.kind === 'text') assert.ok(item.x + estimateTextWidth(item.text, item.size, item.bold) <= left + width + 0.01, 'actual measured glyphs fit the narrow column');
    }
    const firstHeading = drawn.find(({ item }) => item.kind === 'text' && item.text.startsWith('IDS report'));
    const firstRing = drawn.find(({ item }) => item.kind === 'ring');
    assert.equal(firstHeading?.page, 1); assert.equal(firstHeading?.page, firstRing?.page, 'heading and ring move together before the footer');
  });

  it('exports real report rings with portable PDF dash phases instead of solid failure circles (#6552)', async () => {
    const browser = await browserReportSeams(null);
    const seams = { ...browser, imageSize: browserImageSize, createDoc: async (format: Parameters<typeof browser.createDoc>[0], orientation: Parameters<typeof browser.createDoc>[1]) => {
      // svg2pdf's UMD entry resolves the real jsPDF from Happy-DOM's window.
      const pdfWindow = window as Window & { jspdf?: typeof jspdf };
      const previous = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
      try { return await browser.createDoc(format, orientation); } finally { pdfWindow.jspdf = previous; }
    } };
    const result = await generateDocumentPdf({
      document: { ...spec, blocks: spec.blocks.map((block) => ({ ...block, benchmarks: true })) },
      bindings: { models: [], activeModelId: null, today: new Date(0) }, aggregations: new Map(), chartMessages: new Map(),
      snapshotIds: () => [], topics: new Map(), tables: new Map(),
    }, seams);
    // Actual jsPDF/svg2pdf output, not a mock seam or a byte snapshot. PDF
    // 1.x leaves negative dash-phase semantics undefined; our downloaded
    // mixed-result rings rendered solid red in MuPDF. Nonnegative phases
    // express the same clockwise arcs portably across these PDF readers.
    const pdf = new TextDecoder('latin1').decode(await result.blob.arrayBuffer());
    const dashes = [...pdf.matchAll(/\[([^\]]+)\]\s+(-?[\d.]+)\s+d\b/g)];
    assert.equal([...pdf.matchAll(/\nS\n/g)].length, 14, 'both variants export every outcome segment plus each background track');
    for (const dash of dashes) assert.ok(Number(dash[2]) >= 0, 'every actual printed segment uses a portable nonnegative dash phase');
    assert.ok(pdf.includes('62% passed') && pdf.includes('50% passed'), 'the exported labels retain both actual engine verdicts');
  });

  it('preserves the authored title and hidden-ring choice when refreshing a real IDS run and replacing it with actual saved information evidence', async () => {
    const first = { ...spec.blocks[0], benchmarks: false, variant: "compact" as const, specificationsOnly: true }; assert.ok(first.kind === "ids-report");
    const model = useViewerStore.getState().models.get('m'); assert.ok(model?.ifcDataStore);
    const definition = { ...ids, info: { title: 'Updated IDS definition' } };
    const updated = await validateIDS(definition, createDataAccessor(model.ifcDataStore, model.id),
      { modelId: model.id, schemaVersion: model.ifcDataStore.schemaVersion, entityCount: model.ifcDataStore.entityCount }, { includePassingEntities: true });
    let saved: string | null = null;
    act(() => {
      useViewerStore.setState({ documents: [{ ...spec, blocks: [first] }], activeDocumentId: spec.id });
      useViewerStore.getState().setIdsValidationReport(updated, validationReportSnapshot(updated, useViewerStore.getState().models, 'current'));
      saved = useViewerStore.getState().saveValidationReport(validationReportSnapshot(reports[1], useViewerStore.getState().models, 'information'), 'Frozen information run');
    });
    assert.ok(saved, 'the actual canonical writer accepted the engine snapshot');
    const ui = render(<DocumentPanel />); await settle();
    const title = ui.querySelector<HTMLInputElement>(`[data-block-editor="${first.id}"] input[aria-label="Block title"]`);
    assert.ok(title); typeInput(title, 'Authored validation heading'); await settle();
    const refresh = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current validation report');
    assert.ok(refresh, 'the real report-source refresh action is present'); click(refresh); await settle();
    const stored = () => useViewerStore.getState().documents[0].blocks[0];
    let block = stored(); assert.ok(block.kind === 'ids-report');
    assert.equal(block.sourceName, definition.info.title, 'refresh really replaced the source evidence');
    assert.equal(block.title, 'Authored validation heading', 'refresh preserves the independently authored title');
    assert.equal(block.benchmarks, false); assert.equal(ui.querySelector('[data-validation-benchmark]'), null); assert.equal(block.specificationsOnly, true, "refresh preserves the specifications-only choice (#6560)");
    const select = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]'); assert.ok(select);
    act(() => { select.value = saved!; select.dispatchEvent(new window.Event('change', { bubbles: true })); }); await settle();
    block = stored(); assert.ok(block.kind === 'ids-report');
    assert.equal(block.sourceKind, 'rules'); assert.equal(block.sourceName, rules.name);
    assert.equal(block.title, 'Authored validation heading', 'source selection preserves the independently authored title');
    assert.ok(ui.querySelector(`[data-preview-block="${first.id}"]`)?.textContent?.includes('Authored validation heading'));
    assert.deepEqual(block.summary, { checked: 12, passed: 6, failed: 3, warnings: 3, passRate: 50 });
    assert.equal(block.variant, first.variant); assert.equal(block.id, first.id); assert.equal(block.benchmarks, false); assert.equal(block.specificationsOnly, true, "source selection preserves the specifications-only choice (#6560)");
    assert.equal(ui.querySelector('[data-validation-benchmark]'), null, 'selecting another source does not re-enable a hidden ring');
  });

  it('keeps actual mixed-result rings below an enlarged page heading and prints both fonts and outcome colors (#6552 / #6554)', async () => {
    const document = { ...spec, pageHeading: { text: 'Mixed validation handover', font: 'times' as const, fontSize: 48, textColor: '#6b21a8' },
      blocks: spec.blocks.map((block) => ({ ...block, benchmarks: true })) };
    const measuring = new jspdf.jsPDF({ unit: 'pt' });
    const layout = composeDocument({ name: document.name, page: document.page, pageHeading: document.pageHeading,
      blocks: document.blocks.filter((block) => block.kind === 'ids-report'), generatedAt: '',
      measure: (text, size, bold, font) => { measuring.setFont(font ?? 'helvetica', bold ? 'bold' : 'normal'); measuring.setFontSize(size); return measuring.getTextWidth(text); } });
    assert.ok(layout.pageHeading);
    const headingText = layout.pageHeading.text;
    assert.ok(headingText.startsWith('Mixed validation'), 'the enlarged authored heading uses the canonical measured one-line truncation');
    const rings = layout.pages.flatMap((page) => page.items).filter((item) => item.kind === 'ring');
    assert.equal(rings.length, 4);
    for (const ring of rings) {
      assert.ok(ring.y >= REPORT_MARGIN + 30 + layout.pageHeading.extraHeight, 'ring starts below the enlarged heading reservation');
      assert.ok(ring.y + ring.size <= layout.size.h - REPORT_MARGIN - 24, 'ring stays above the unchanged footer');
    }
    const pdfWindow = window as Window & { jspdf?: typeof jspdf };
    const prior = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
    let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
    try {
      result = await generateDocumentPdf({ document, bindings: { models: [], activeModelId: null, today: new Date(0) },
        aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), tables: new Map() },
      { ...await browserReportSeams(null), imageSize: browserImageSize });
    } finally { pdfWindow.jspdf = prior; }
    const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
      standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
    const printed: string[] = [], strokes: unknown[] = [];
    try {
      const parsed = await task.promise;
      for (let number = 1; number <= parsed.numPages; number++) {
        const page = await parsed.getPage(number);
        try {
          const text = await page.getTextContent();
          const heading = text.items.find((item) => 'str' in item && item.str === headingText);
          assert.ok(heading && 'str' in heading); assert.equal(heading.transform[0], 48);
          assert.equal(text.styles[heading.fontName].fontFamily, 'serif');
          const footer = text.items.find((item) => 'str' in item && item.str.startsWith('Page '));
          assert.ok(footer && 'str' in footer); assert.equal(footer.transform[0], 8);
          printed.push(...text.items.flatMap((item) => 'str' in item ? [item.str] : []));
          const operators = await page.getOperatorList();
          strokes.push(...operators.fnArray.flatMap((op, index) => op === reader.OPS.setStrokeRGBColor ? [operators.argsArray[index][0]] : []));
        } finally { page.cleanup(); }
      }
    } finally { await task.destroy(); }
    for (const verdict of ['62% passed', '50% passed']) assert.ok(printed.some((text) => text.includes(verdict)), `${verdict} actual engine summary survives header rendering`);
    const rgb = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    for (const bucket of ['pass', 'warning', 'fail'] as const) {
      const expected = rgb(RING_COLORS[bucket]);
      // jsPDF's three-decimal normalized RGB operands round by at most one
      // 8-bit channel when the independent PDF reader expands them again.
      assert.ok(strokes.some((color) => typeof color === 'string' && rgb(color).every((channel, index) => Math.abs(channel - expected[index]) <= 1)),
        `${bucket} actual ring ink remains after the header font/color changes: ${JSON.stringify(strokes)}`);
    }
  });

});
