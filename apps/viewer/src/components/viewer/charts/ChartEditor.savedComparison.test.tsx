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
import { diffModels } from '@ifc-lite/diff';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { aggregate, renderChartSvg, type ChartDataset, type ChartSource, type ChartSpec } from '@ifc-lite/charts';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { prepareDocument } from '@/lib/document/prepare-document';
import { buildReportDocument } from '@/lib/document/build-report-document';
import { documentPdfWarnings, exportPreparedDocument } from '@/lib/document/export-prepared-document';
import { browserReportSeams, generateReportPdf, type ReportPdfSeams } from '@/lib/export/report/generate-report-pdf';
import { DocumentPreview } from '../document/DocumentPreview';
import { useDocumentData, type DocumentData } from '../document/useDocumentData';
import { ChartCard } from './ChartCard';
import { ChartsPanel } from './ChartsPanel';
import { chartBucketIdentity, useChart3DLink } from './useChart3DLink';
import type { ChartRenderer, ChartRendererEvents } from './useEChart';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { effectiveComparePair } from '@/lib/compare/effectiveCompareStore';
import { snapshotComparison, type SavedComparison } from '@/lib/compare/savedComparisons';
import { buildCompareDataset } from '@/lib/charts/datasets/compare';
import { loadDashboards, parseDashboardFile } from '@/lib/charts/persistence';
import type { CompareResult } from '@/store/slices/compareSlice';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click } from '@/test/render';
import { ChartEditor } from './ChartEditor';

const original = useViewerStore.getState();
const catalog = { attributes: [], properties: new Map(), quantities: new Map(), relations: [] };
let saved: SavedComparison[];
let live: CompareResult;

// Real SketchUp source and the repository's derived revision B, plus an
// explicitly authored StoreEditor rename on B. No handcrafted diff/report.
beforeEach(async () => {
  localStorage.clear();
  const models = await Promise.all(['A', 'B', 'C'].map(async (id) => {
    const name = id === 'A' ? 'building-architecture.ifc' : 'building-architecture-rev-b.ifc';
    const bytes = await readFile(new URL(`../../../../public/samples/${name}`, import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { ...fixtureModel(id), name: id === 'C' ? 'Declared renamed revision C' : name, schemaVersion: 'IFC4' as const, ifcDataStore: store };
  }));
  const c = models[2], view = new MutablePropertyView(c.ifcDataStore.properties, c.id);
  const wall = c.ifcDataStore.entities.getExpressIdByGlobalId('1AQAupaRP1txwK1AGiN61V');
  assert.ok(wall, 'real source wall exists before the declared rename');
  new StoreEditor(c.ifcDataStore, view).setAttribute(wall, 'Name', 'Explicit chart test revision C wall');
  const run = async (baseIndex: number, headIndex: number): Promise<CompareResult> => {
    const base = models[baseIndex], head = models[headIndex];
    const { baseEffective, headEffective, comparedStores } = await effectiveComparePair(
      [base, base.ifcDataStore], [head, head.ifcDataStore], (id) => id === 'C' ? view : null);
    const baseFingerprints = await buildEntityFingerprints({ modelId: base.id, store: baseEffective, meshes: [], idOffset: base.idOffset });
    const headFingerprints = await buildEntityFingerprints({ modelId: head.id, store: headEffective, meshes: [], idOffset: head.idOffset });
    return { baseModelId: base.id, headModelId: head.id, baseName: base.name, headName: head.name,
      scope: 'data', geometryUnavailable: true, excludedHiddenIds: new Set(), mutationVersion: 0, comparedStores,
      diff: diffModels(baseFingerprints, headFingerprints, { scope: 'data' }) };
  };
  const ab = await run(0, 1); live = await run(1, 2);
  const federation = fixtureModels(...models);
  saved = [snapshotComparison(ab, federation.models, 'Public derived A to B'), snapshotComparison(live, federation.models, 'Declared B to C rename')];
  assert.ok(saved[0].report.rows.some((row) => row.state === 'added'));
  assert.ok(saved[0].report.rows.some((row) => row.state === 'deleted'));
  assert.ok(saved[1].report.rows.some((row) => row.name === 'Explicit chart test revision C wall'));
  assert.notDeepEqual(saved[0].report.rows, saved[1].report.rows);
  useViewerStore.setState({ ...federation, savedComparisons: [], savedComparisonsLoadIssue: null,
    dashboards: [], activeDashboardId: null, compareResult: live, compareRunSeq: 2,
    mutationViews: new Map(), mutationVersion: 0, chartSlice: null, chartSliceSource: null, chartSliceBuckets: null });
  for (const snapshot of saved) assert.equal(useViewerStore.getState().saveComparison(snapshot), true);
});
afterEach(() => { cleanup(); setLocale('en'); useViewerStore.setState(original); localStorage.clear(); });

const chart = (): ChartSpec => ({ id: 'chosen-comparison', title: 'Selected comparison', source: 'compare', type: 'bar', dimension: 'State', measure: { agg: 'count' } });
function documentFor(spec: ChartSpec): DocumentSpec {
  return { version: DOCUMENT_VERSION, id: 'recorded-document', name: 'Recorded comparison proof', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'chart', id: 'recorded-block', chart: spec, snapshot: true }] };
}
function datasets(): Record<ChartSource, ChartDataset> {
  const empty = (source: ChartSource): ChartDataset => ({ source, columns: [], rows: [], fingerprint: source });
  return { elements: empty('elements'), clash: empty('clash'), bcf: empty('bcf'), schedule: empty('schedule'), ids: empty('ids'), compare: buildCompareDataset(useViewerStore.getState()) };
}
function choose(select: HTMLSelectElement, value: string): void {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
const settle = async () => { for (let index = 0; index < 6; index++) await act(async () => { await Promise.resolve(); }); };
function DocumentProbe({ document, observe }: { document: DocumentSpec; observe: (data: DocumentData) => void }) {
  const data = useDocumentData(document); observe(data);
  return <DocumentPreview document={document} {...data} selectedBlockId={null} onSelectBlock={() => {}} />;
}
function CardProbe({ spec, renderer }: { spec: ChartSpec; renderer: ChartRenderer }) {
  return <ChartCard spec={spec} dataset={datasets().compare} link={useChart3DLink()} renderer={renderer}
    onEdit={() => {}} onDuplicate={() => {}} onRemove={() => {}} />;
}
async function pdfText(blob: Blob): Promise<string> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const parsed = await task.promise, text: string[] = [];
    for (let number = 1; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number);
      try { text.push(...(await page.getTextContent()).items.flatMap((item) => 'str' in item ? [item.str] : [])); }
      finally { page.cleanup(); }
    }
    return text.join(' ');
  } finally { await task.destroy(); }
}

function installSvgCdataEnvironmentConversion(): () => void {
  const originalParser = globalThis.DOMParser;
  // HappyDOM 20's XML parser rejects CDATA in ECharts' valid SVG stylesheet.
  // Only the test parser encodes that same text as XML entities; the actual
  // renderer output, CSS content, elements and geometry remain unchanged.
  globalThis.DOMParser = class extends originalParser {
    override parseFromString(...[source, type]: Parameters<DOMParser['parseFromString']>): Document {
      const encoded = type === 'image/svg+xml' && typeof source === 'string'
        ? source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        : source;
      const parsed = super.parseFromString(encoded, type);
      if (type === 'image/svg+xml' && typeof source === 'string') {
        const stylesheet = /<style[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/style>/.exec(source);
        if (stylesheet) assert.equal(parsed.querySelector('style')?.textContent, stylesheet[1], 'test XML conversion retains actual renderer CSS text');
      }
      return parsed;
    }
  };
  return () => { globalThis.DOMParser = originalParser; };
}

describe('Saved comparison chart source (#6549)', () => {
  it('offers completed canonical comparisons and persists the chosen source through dashboard reload/import', () => {
    let accepted: ChartSpec | undefined;
    const ui = render(<ChartEditor spec={chart()} datasets={datasets()} onSave={(spec) => { accepted = spec; }} onCancel={() => {}}
      elementFieldCatalog={catalog} elementFieldCatalogLoading={false} />);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved comparison"]');
    assert.ok(picker, 'chart authors can choose an actual saved comparison instead of the latest live result');
    assert.deepEqual([...picker.options].filter((option) => option.value).map((option) => option.value), saved.map((snapshot) => snapshot.id));
    choose(picker, saved[0].id);
    assert.ok(ui.textContent?.includes(`Source (${saved[0].report.rows.length} rows)`), 'editor row count describes the selected recorded report');
    const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart'); assert.ok(save); click(save);
    assert.ok(accepted); assert.equal(accepted.comparisonId, saved[0].id);
    const dashboard = { version: 2 as const, id: 'saved-source', name: 'Chosen source', scope: { kind: 'all' as const }, charts: [accepted], layout: [{ chartId: accepted.id, x: 0, y: 0, w: 6, h: 4 }] };
    useViewerStore.getState().upsertDashboard(dashboard);
    assert.equal(loadDashboards()[0].charts[0].comparisonId, saved[0].id);
    assert.equal(parseDashboardFile(JSON.stringify(dashboard)).charts[0].comparisonId, saved[0].id);
  });

  it('projects the canonical saved report rather than a later live run, with no entity IDs across one or multiple loaded models', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    const liveDataset = datasets().compare;
    assert.ok(liveDataset.rows.length > saved[1].report.rows.length, 'legacy live diff includes unchanged entities');
    let data: DocumentData | undefined, legacy: DocumentData | undefined;
    render(<DocumentProbe document={documentFor(spec)} observe={(value) => { data = value; }} />);
    render(<DocumentProbe document={documentFor(chart())} observe={(value) => { legacy = value; }} />); await settle();
    const result = data?.aggregations.get('recorded-block'); assert.ok(result);
    assert.equal(result.total, saved[0].report.rows.length);
    const recordedCounts = new Map<string, number>();
    for (const row of saved[0].report.rows) recordedCounts.set(row.state, (recordedCounts.get(row.state) ?? 0) + 1);
    assert.deepEqual(result.categories.map((bucket) => [bucket.key, bucket.value]).sort(), [...recordedCounts].sort());
    assert.ok(result.categories.every((bucket) => bucket.ids.length === 0), 'portable saved report GUIDs never become live numeric selections');
    assert.equal(legacy?.aggregations.get('recorded-block')?.total, liveDataset.rows.length, 'unbound legacy chart counts every current diff entry');
    const svg = renderChartSvg({ aggregation: result, width: 520, height: 240, print: true });
    assert.match(svg, /added/); assert.match(svg, /deleted/); assert.doesNotMatch(svg, /NaN|Infinity/);
    const one = useViewerStore.getState().models.values().next().value; assert.ok(one);
    act(() => useViewerStore.setState({ ...fixtureModels(one), compareResult: null, compareRunSeq: 99 }));
    await settle();
    const rebound = data?.aggregations.get('recorded-block'); assert.ok(rebound);
    assert.equal(rebound.dataFingerprint, result.dataFingerprint); assert.equal(rebound.total, result.total);
    assert.deepEqual(rebound.categories.map((bucket) => [bucket.key, bucket.value]), result.categories.map((bucket) => [bucket.key, bucket.value]));
    assert.equal(legacy?.aggregations.get('recorded-block')?.total, 0, 'only unbound legacy charts follow the cleared live result');
    act(() => useViewerStore.setState({ ...fixtureModels(), compareResult: null })); await settle();
    assert.equal(data?.aggregations.get('recorded-block')?.dataFingerprint, result.dataFingerprint);
    assert.equal(data?.aggregations.get('recorded-block')?.total, result.total, 'recorded document data remains available without a loaded model');
  });

  it('reports a deleted history dependency explicitly instead of falling back to the nonempty current comparison', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    assert.equal(useViewerStore.getState().deleteSavedComparison(saved[0].id), true);
    let data: DocumentData | undefined;
    render(<DocumentProbe document={documentFor(spec)} observe={(value) => { data = value; }} />); await settle();
    assert.equal(data?.aggregations.get('recorded-block')?.total, 0);
    assert.ok(datasets().compare.rows.length > 0);
    assert.match(data?.chartMessages.get('recorded-block') ?? '', /latest run is not substituted/);
    const ui = render(<ChartEditor spec={spec} datasets={datasets()} elementFieldCatalog={catalog} elementFieldCatalogLoading={false} onSave={() => assert.fail('missing dependency cannot save')} onCancel={() => {}} />);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved comparison"]'); assert.ok(picker);
    assert.equal(picker.value, saved[0].id, 'missing source remains visible until explicitly replaced');
    const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart'); assert.ok(save?.disabled);
  });

  it('invalidates the dataset fingerprint for an actual replacement report with the same history ID, while rename preserves data', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    let data: DocumentData | undefined;
    const ui = render(<DocumentProbe document={documentFor(spec)} observe={(value) => { data = value; }} />); await settle();
    const first = data?.aggregations.get('recorded-block'); assert.ok(first);
    act(() => { assert.equal(useViewerStore.getState().renameSavedComparison(saved[0].id, 'Renamed saved source'), true); }); await settle();
    assert.equal(data?.aggregations.get('recorded-block')?.dataFingerprint, first.dataFingerprint); assert.match(ui.textContent ?? '', /Renamed saved source/);
    act(() => { assert.equal(useViewerStore.getState().saveComparison({ ...saved[1], id: saved[0].id }), true); }); await settle();
    const replaced = data?.aggregations.get('recorded-block'); assert.ok(replaced);
    assert.notEqual(replaced.dataFingerprint, first.dataFingerprint); assert.equal(replaced.total, saved[1].report.rows.length);
  });

  it('requires a saved choice for a newly authored comparison chart and retranslates the live picker without changing its binding', () => {
    let accepted: ChartSpec | undefined;
    const ui = render(<ChartEditor isNew spec={chart()} datasets={datasets()} elementFieldCatalog={catalog} elementFieldCatalogLoading={false} onSave={(spec) => { accepted = spec; }} onCancel={() => {}} />);
    const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart'); assert.ok(save?.disabled);
    assert.ok(ui.textContent?.includes('Source (choose a saved comparison)'), 'an unchosen new source does not present the latest live run as its row count');
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved comparison"]'); assert.ok(picker);
    choose(picker, saved[1].id); assert.equal(save.disabled, false);
    const strings: Catalogue = { 'chartComparison.label': 'Gespeicherter Vergleich', 'chartComparison.choose': 'Gespeicherten Vergleich auswählen' };
    registerLocale('de-6549', strings); act(() => setLocale('de-6549'));
    assert.equal(picker.getAttribute('aria-label'), 'Gespeicherter Vergleich'); assert.equal(picker.value, saved[1].id);
    click(save); assert.equal(accepted?.comparisonId, saved[1].id);
  });

  it('ignores unrelated live selection slices and chart clicks when a card displays recorded comparison rows', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    const currentWall = live.diff.entries.find((entry) => entry.state === 'modified')?.head?.ref.globalId; assert.ok(currentWall);
    const unrelated = aggregate({ ...chart(), id: 'unrelated-live-chart' }, datasets().compare);
    const index = unrelated.categories.findIndex((bucket) => bucket.ids.includes(currentWall)); assert.ok(index >= 0);
    const identity = chartBucketIdentity(unrelated, { seriesIndex: 0, dataIndex: index }); assert.ok(identity);
    act(() => {
      useViewerStore.getState().setSelectedEntityIds([currentWall]);
      const state = useViewerStore.getState();
      state.setChartSlice(new Set([currentWall]), unrelated.spec.id, [identity], state.selectionRevision);
    });
    let events: ChartRendererEvents | undefined;
    const renderer: ChartRenderer = async () => (_element, handlers) => {
      events = handlers;
      return { setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => {} };
    };
    const ui = render(<CardProbe spec={spec} renderer={renderer} />); await settle();
    const legend = ui.querySelector('[data-chart-legend]'); assert.ok(legend);
    assert.match(legend.textContent ?? '', /added/); assert.match(legend.textContent ?? '', /deleted/);
    assert.ok([...legend.querySelectorAll('button')].every((button) => button.disabled));
    const frame = ui.querySelector<HTMLButtonElement>('button[aria-label="Frame Selected comparison"]'); assert.ok(frame?.disabled);
    assert.ok(events); act(() => { events?.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); events?.onSelect({ items: [] }); });
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [currentWall], 'recorded chart callbacks cannot replace or clear unrelated model selection');
    assert.deepEqual([...useViewerStore.getState().chartSlice ?? []], [currentWall]);
  });

  it('uses the same saved rows in real document SVG and both actual PDFs, suppressing unrelated snapshot callbacks and printing deleted-source notices', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'recorded-document', name: 'Recorded comparison proof',
      page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'chart', id: 'recorded-block', chart: spec, snapshot: true }] };
    let data: DocumentData | undefined;
    const ui = render(<DocumentProbe document={document} observe={(value) => { data = value; }} />); await settle();
    assert.ok(data);
    assert.match(ui.querySelector('svg')?.textContent ?? '', /added/); assert.match(ui.querySelector('svg')?.textContent ?? '', /deleted/);
    assert.doesNotMatch(ui.textContent ?? '', /3D snapshot in the PDF/);
    const agg = data.aggregations.get('recorded-block'); assert.ok(agg);
    assert.equal(agg.total, saved[0].report.rows.length);
    let captures = 0;
    const pdfWindow = window as Window & { jspdf?: typeof jspdf };
    const previous = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
    const restoreParser = installSvgCdataEnvironmentConversion();
    try {
      const browser = await browserReportSeams(null);
      const seams = { ...browser, imageSize: browserImageSize, capture: async () => { captures++; assert.fail('recorded report data cannot invoke a snapshot callback for unrelated loaded models'); } };
      const doc = await generateDocumentPdf({ document, ...data, snapshotIds: () => [] }, seams);
      assert.equal(captures, 0);
      const printed = await pdfText(doc.blob); assert.match(printed, /added/); assert.match(printed, /deleted/);
      assert.deepEqual(documentPdfWarnings(doc), [], 'recorded source provenance is informative, not an unavailable-chart failure (#6549 / #6612)');
      const report = await generateReportPdf({ name: 'Recorded dashboard proof', page: document.page, titleBlock: {}, snapshots: true,
        charts: [{ id: spec.id, title: spec.title, aggregation: agg }], snapshotIds: () => [] }, seams);
      assert.equal(report.charts, 1); assert.equal(report.snapshots, 0); assert.equal(captures, 0);
      assert.match(await pdfText(report.blob), /added/);
      act(() => { assert.equal(useViewerStore.getState().deleteSavedComparison(saved[0].id), true); }); await settle();
      assert.ok(data); assert.equal(data.aggregations.get('recorded-block')?.total, 0);
      assert.match(ui.textContent ?? '', /Saved comparison unavailable/);
      const missing = await generateDocumentPdf({ document, ...data, snapshotIds: () => [] }, seams);
      assert.ok(documentPdfWarnings(missing).some((warning) => warning.includes('Saved comparison unavailable')), 'missing history remains an artifact failure');
      assert.equal(captures, 0); const missingText = await pdfText(missing.blob); assert.match(missingText, /Choose another saved comparison/);
      assert.equal(missingText.split('Saved comparison unavailable in this browser.').length - 1, 1, 'the actual document PDF prints the missing source notice once');
      assert.equal((ui.textContent ?? '').split('Saved comparison unavailable in this browser.').length - 1, 1, 'the missing source notice appears once in the actual preview');
      const missingReport = await generateReportPdf({ name: 'Missing saved source', page: document.page, titleBlock: {}, snapshots: true,
        charts: [{ id: spec.id, title: spec.title, aggregation: data.aggregations.get('recorded-block') ?? null, message: data.chartMessages.get('recorded-block') }], snapshotIds: () => [] }, seams);
      assert.equal(captures, 0); const missingReportText = await pdfText(missingReport.blob); assert.match(missingReportText, /Choose another saved comparison/);
      assert.equal(missingReportText.split('Saved comparison unavailable in this browser.').length - 1, 1, 'the actual dashboard PDF prints the missing source notice once');
    } finally { restoreParser(); pdfWindow.jspdf = previous; }
  });

  it('exports through the mounted dashboard dialog after actual card updates, and keeps recorded charts usable without loaded models', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    const dashboard = { version: 2 as const, id: 'recorded-dashboard', name: 'Recorded dashboard', scope: { kind: 'all' as const },
      charts: [spec], layout: [{ chartId: spec.id, x: 0, y: 0, w: 6, h: 4 }] };
    act(() => { useViewerStore.getState().upsertDashboard(dashboard); useViewerStore.setState({ activeDashboardId: dashboard.id }); });
    const outputs: Blob[] = [];
    let captures = 0;
    const renderer: ChartRenderer = async () => () => ({ setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => {} });
    const seams = async (): Promise<ReportPdfSeams> => {
      const real = await browserReportSeams(null);
      return { ...real, createDoc: async (format, orientation) => {
        const doc = await real.createDoc(format, orientation);
        return { ...doc, output: () => { const blob = doc.output(); outputs.push(blob); return blob; } };
      }, capture: async () => { captures++; assert.fail('recorded dashboard cannot request a snapshot of unrelated current models'); } };
    };
    const pdfWindow = window as Window & { jspdf?: typeof jspdf };
    const previous = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
    const restoreParser = installSvgCdataEnvironmentConversion();
    try {
      const ui = render(<ChartsPanel renderer={renderer} reportSeams={seams} />); await settle();
      assert.match(ui.querySelector('[data-chart-legend]')?.textContent ?? '', /added/);
      act(() => useViewerStore.setState({ ...fixtureModels(), compareResult: null })); await settle();
      assert.match(ui.querySelector('[data-chart-legend]')?.textContent ?? '', /deleted/, 'recorded dashboard survives model unload');
      const exportFromDialog = async (): Promise<string> => {
        const trigger = ui.querySelector('button[title="Print this dashboard to a PDF report"]'); assert.ok(trigger); click(trigger); await settle();
        const dialog = globalThis.document.querySelector('[data-report-dialog]'); assert.ok(dialog);
        const button = dialog.querySelector('[data-report-export]'); assert.ok(button);
        const count = outputs.length; click(button);
        for (let index = 0; index < 100 && (outputs.length === count || globalThis.document.querySelector('[data-report-dialog]')); index++) {
          await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); }); await settle();
        }
        assert.equal(outputs.length, count + 1, 'mounted Export creates one actual jsPDF output');
        return pdfText(outputs[count]);
      };
      const first = await exportFromDialog(); assert.match(first, /added/); assert.match(first, /deleted/);
      act(() => { assert.equal(useViewerStore.getState().deleteSavedComparison(saved[0].id), true); }); await settle();
      assert.match(ui.querySelector('[data-chart-empty]')?.textContent ?? '', /Saved comparison unavailable/);
      const missing = await exportFromDialog(); assert.match(missing, /Choose another saved comparison/); assert.doesNotMatch(missing, /\badded\b|\bdeleted\b/);
      assert.equal(missing.split('Saved comparison unavailable in this browser.').length - 1, 1, 'mounted dashboard export prints one missing-source notice');
      assert.equal(captures, 0);
      act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, charts: [chart()] })); await settle();
      assert.equal(ui.querySelector('[data-chart-legend]'), null, 'unbound legacy dashboard still requires loaded model data');
      assert.match(ui.textContent ?? '', /Load.*model/i);
    } finally { restoreParser(); pdfWindow.jspdf = previous; }
  });

  it('uses the chosen saved source through actual awaited workflow template preparation and PDF diagnostics (#6549 / #6612)', async () => {
    const spec = { ...chart(), comparisonId: saved[0].id };
    const template = documentFor(spec);
    template.blocks.push({ kind: 'table', id: 'mapped-evidence', maxRows: 10, source: { kind: 'comparison', comparison: saved[1] } });
    const document = buildReportDocument({ template,
      mappings: [{ blockId: 'mapped-evidence', jobId: 'completed-bc' }],
      results: [{ jobId: 'completed-bc', resultId: saved[1].id, kind: 'comparison', comparison: saved[1] }] });
    const block = document.blocks.find((item) => item.kind === 'chart'); assert.ok(block?.kind === 'chart');
    assert.equal(block.chart.comparisonId, saved[0].id, 'workflow result B to C must not replace the separately bound A to B chart');
    const state = useViewerStore.getState();
    const input = await prepareDocument(document, state);
    assert.equal(input.aggregations.get(block.id)?.total, saved[0].report.rows.length);
    assert.deepEqual(input.aggregations.get(block.id)?.categories.map((category) => category.label).sort(), ['added', 'deleted', 'modified']);
    const pdfWindow = window as Window & { jspdf?: typeof jspdf };
    const previous = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
    const restoreParser = installSvgCdataEnvironmentConversion();
    let captures = 0;
    try {
      const seams = { ...await browserReportSeams(null), imageSize: browserImageSize,
        capture: async () => { captures++; assert.fail('recorded prepared documents cannot capture unrelated live entities'); } };
      const result = await exportPreparedDocument(input, { seams });
      const printed = await pdfText(result.blob);
      assert.match(printed, /added/); assert.match(printed, /deleted/); assert.match(printed, /Explicit chart test revision C wall/);
      assert.equal(captures, 0); assert.deepEqual(documentPdfWarnings(result), []);
      const noModels = await prepareDocument(document, { ...state, models: new Map(), activeModelId: null, compareResult: null });
      assert.equal(noModels.aggregations.get(block.id)?.total, saved[0].report.rows.length);
      const missing = await prepareDocument(document, { ...state, savedComparisons: [saved[1]] });
      assert.equal(missing.aggregations.get(block.id)?.total, 0, 'nonempty live B to C cannot substitute for deleted A to B');
      const missingResult = await exportPreparedDocument(missing, { seams });
      assert.ok(documentPdfWarnings(missingResult).some((warning) => warning.includes('Saved comparison unavailable')));
      assert.equal((await pdfText(missingResult.blob)).split('Saved comparison unavailable in this browser.').length - 1, 1);
      const legacyResult = await generateDocumentPdf({ document, bindings: input.bindings, aggregations: input.aggregations,
        chartMessages: new Map([[block.id, 'Legacy selector refused']]), snapshotIds: input.snapshotIds,
        topics: input.topics, tables: input.tables }, seams);
      assert.ok(documentPdfWarnings(legacyResult).some((warning) => warning.includes('Legacy selector refused')), 'old callers without classification retain message-to-failure behavior');
      assert.equal(captures, 0);
    } finally { restoreParser(); pdfWindow.jspdf = previous; }
  });

});
