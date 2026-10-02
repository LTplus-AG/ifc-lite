/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One heading editor for every block kind (#6632): size, ink and background are edited by the same
 * controls, drawn by the preview and by the PDF from the same values, kept when a block's source is
 * replaced, and persisted. The preview is read from the mounted DOM and the PDF from what it is asked
 * to draw, so neither is asserted by its source text.
 */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { IfcTypeEnum } from '@ifc-lite/data';
import { useViewerStore } from '@/store/index.js';
import { blur, click, cleanup, render, type, waitFor } from '@/test/render.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence.js';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { blockTitleFields } from '@/lib/document/block-title';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec, type IdsReportBlock } from '@/lib/document/types.js';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { BlockEditor } from './BlockEditor.js';
import { DocumentPanel } from './DocumentPanel.js';

const SIZE = 20;
const INK = '#1264c8';
const FILL = '#f1c35a';
const A4_WIDTH = 595.28;
const PREVIEW_WIDTH = 560;
const KINDS = ['text', 'image', 'chart', 'topic', 'table', 'ids-report', 'manual-report'] as const;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const idsBlock: IdsReportBlock = { kind: 'ids-report', id: 'ids-report', variant: 'compact', specificationsOnly: true, benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 },
  checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }] };
const spec = (): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'doc-6632', name: 'Headings', page: { size: 'A4', orientation: 'portrait' }, blocks: [
  { kind: 'text', id: 'text', style: 'body', text: 'Body text' },
  { kind: 'image', id: 'image', dataUrl: PNG, height: 40, align: 'left' },
  { kind: 'chart', id: 'chart', chart: { id: 'c', title: 'Chart source', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, height: 120 },
  { kind: 'topic', id: 'topic', guid: 'topic-guid', snapshot: false },
  { kind: 'table', id: 'table', source: { kind: 'list', list: { id: 'l', name: 'List source', createdAt: 1, updatedAt: 1, entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  idsBlock,
  manualReportBlockFromChecklist({ checklist: { version: CHECKLIST_VERSION, name: 'Checklist source', groups: [{ id: 'g', name: 'Review', items: [{ id: 'a', text: 'Check' }] }] },
    answers: { a: { status: 'pass', updatedAt: 1 } }, now: new Date(0) }, 'manual-report'),
] });

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
/** The element a preview block renders its heading in: the smallest element whose own text is exactly the heading. */
function headingOf(ui: HTMLElement, blockId: string, text: string): HTMLElement {
  const found = [...ui.querySelectorAll<HTMLElement>(`[data-preview-block="${blockId}"] *`)].find((el) => el.children.length === 0 && el.textContent === text);
  assert.ok(found, `${blockId}: the preview renders the heading "${text}"`);
  return found;
}
function commitSize(input: HTMLInputElement, value: string): void {
  type(input, value);
  blur(input);
}
function selectOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  assert.ok(setter, 'a select value setter exists');
  act(() => { setter.call(select, value); select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}

beforeEach(() => {
  localStorage.clear();
  const document = spec();
  useViewerStore.setState({ models: new Map(), activeModelId: null, documents: [document], activeDocumentId: document.id, dashboards: [], selectedEntityIds: new Set(),
    mutationViews: new Map(), mutationVersion: 0, idsValidationReport: null, validationSource: null, savedValidationReports: [],
    bcfProject: { version: '3.0', topics: new Map([['topic-guid', { guid: 'topic-guid', title: 'Topic source', description: 'Coordinate', viewpoints: [], comments: [] }]]) } });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('shared block heading controls (#6632)', () => {
  it('every kind with a heading edits size, ink and background through the same controls; preview and PDF draw the same values', async () => {
    const ops: Array<{ text?: string; size: number; ink: number | string; fill?: string }> = [];
    let size = 0; let ink: number | string = 0;
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async () => ({ addPage: () => {}, setFont: () => {}, setFontSize: (s) => { size = s; }, setTextColor: (c) => { ink = c; },
        text: (text) => { ops.push({ text, size, ink }); }, fillRect: (_x, _y, _w, _h, color) => { ops.push({ size, ink, fill: color }); },
        addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']) }),
      renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 2, h: 1 }),
    });
    const ui = render(<DocumentPanel pdfSeams={seams} />);
    await settle();

    for (const kind of KINDS) {
      const editor = ui.querySelector<HTMLElement>(`[data-block-kind="${kind}"]`);
      assert.ok(editor, `${kind} has an editor`);
      const sizeInput = editor.querySelector<HTMLInputElement>('input[aria-label="Heading text size"]');
      const inkInput = editor.querySelector<HTMLInputElement>('input[aria-label="Heading colour"]');
      const fillInput = editor.querySelector<HTMLInputElement>('input[aria-label="Heading background"]');
      assert.ok(sizeInput && inkInput && fillInput, `${kind} exposes heading size, colour and background`);
      const titleInput = editor.querySelector<HTMLInputElement>('input[aria-label="Block title"], input[aria-label="Table title"]');
      assert.ok(titleInput, `${kind} exposes the heading text`);
      type(titleInput, `H:${kind}`);
      commitSize(sizeInput, String(SIZE));
      type(inkInput, INK);
      type(fillInput, FILL);
      await settle();
      const block = editor.getAttribute('data-block-editor') ?? '';
      const heading = headingOf(ui, block, `H:${kind}`);
      const style = window.getComputedStyle(heading);
      assert.ok(Math.abs(Number.parseFloat(style.fontSize) - SIZE * (PREVIEW_WIDTH / A4_WIDTH)) < 1e-3, `${kind}: preview size ${style.fontSize} is the authored points at the sheet scale`);
      assert.equal(style.color, INK, `${kind}: preview ink`);
      assert.equal(style.backgroundColor, FILL, `${kind}: preview background`);
    }

    await waitFor(() => useViewerStore.getState().documentsStorage.items['doc-6632'] === 'saved', 'all heading edits must commit before reloading');
    const saved = (await loadDocuments()).find((d) => d.id === 'doc-6632');
    assert.ok(saved);
    for (const block of parseDocumentFile(JSON.stringify(saved)).blocks) {
      assert.deepEqual(blockTitleFields(block as IdsReportBlock), { title: `H:${block.kind}`, titleFontSize: SIZE, titleTextColor: INK, titleBackgroundColor: FILL }, `${block.kind} persists and reloads its heading style`);
    }

    let downloaded = false;
    const onDownload = (): void => { downloaded = true; };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const exportButton = ui.querySelector('[data-document-export]');
      assert.ok(exportButton);
      click(exportButton);
      for (let i = 0; i < 20 && !downloaded; i++) await settle();
      assert.ok(downloaded, 'the PDF was produced');
    } finally { window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload); }
    for (const kind of KINDS) {
      const op = ops.find((o) => o.text === `H:${kind}`);
      assert.ok(op, `${kind}: the heading is in the PDF`);
      assert.equal(op.size, SIZE, `${kind}: PDF size equals the authored points the preview scaled`);
      assert.equal(op.ink, INK, `${kind}: PDF ink equals the preview ink`);
    }
    assert.equal(ops.filter((o) => o.fill === FILL).length, KINDS.length, 'one strip per heading, in the preview colour');
  });

  it('reset returns a heading to the default size, ink and strip on every kind', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    for (const kind of KINDS) {
      const editor = ui.querySelector<HTMLElement>(`[data-block-kind="${kind}"]`);
      assert.ok(editor);
      const input = (label: string) => { const el = editor.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(el, `${kind}: ${label}`); return el; };
      type(editor.querySelector<HTMLInputElement>('input[aria-label="Block title"], input[aria-label="Table title"]')!, `H:${kind}`);
      commitSize(input('Heading text size'), String(SIZE));
      type(input('Heading colour'), INK);
      type(input('Heading background'), FILL);
      await settle();
      click(editor.querySelector('[aria-label="Reset heading colour"]')!);
      click(editor.querySelector('[aria-label="Clear heading background"]')!);
      commitSize(input('Heading text size'), '');
      await settle();
    }
    await waitFor(() => useViewerStore.getState().documentsStorage.items['doc-6632'] === 'saved', 'all heading resets must commit before reloading');
    for (const block of (await loadDocuments())[0].blocks) {
      assert.deepEqual(blockTitleFields(block as IdsReportBlock), { title: `H:${block.kind}`, titleFontSize: undefined, titleTextColor: undefined, titleBackgroundColor: undefined }, `${block.kind} keeps only its text`);
    }
  });

  it('clamps the size into the bounds and gives a spacer and a page break no heading controls', async () => {
    const document = spec();
    document.blocks.push({ kind: 'spacer', id: 'spacer', height: 10 }, { kind: 'page-break', id: 'break' });
    useViewerStore.setState({ documents: [document] });
    const ui = render(<DocumentPanel />);
    await settle();
    const editor = ui.querySelector<HTMLElement>('[data-block-kind="text"]');
    const input = editor?.querySelector<HTMLInputElement>('input[aria-label="Heading text size"]');
    assert.ok(editor && input);
    commitSize(input, '99');
    await settle();
    await waitFor(() => useViewerStore.getState().documentsStorage.items['doc-6632'] === 'saved', 'clamped heading size must commit before reloading');
    assert.equal(((await loadDocuments())[0].blocks[0] as { titleFontSize?: number }).titleFontSize, 24, 'above the maximum clamps to it');
    commitSize(input, '1');
    await settle();
    await waitFor(() => useViewerStore.getState().documentsStorage.items['doc-6632'] === 'saved', 'clamped heading size must commit before reloading');
    assert.equal(((await loadDocuments())[0].blocks[0] as { titleFontSize?: number }).titleFontSize, 6, 'below the minimum clamps to it');
    for (const kind of ['spacer', 'page-break']) {
      assert.equal(ui.querySelector(`[data-block-kind="${kind}"] input[aria-label="Heading text size"]`), null, `${kind} has no heading to size`);
    }
  });
});

describe('heading style survives replacing a report block source (#6632)', () => {
  const BINDINGS: BindingContext = { models: [], activeModelId: null, today: new Date(0) };
  const noop = (): void => {};
  const styled: IdsReportBlock = { ...idsBlock, title: 'Mine', titleFontSize: SIZE, titleTextColor: INK, titleBackgroundColor: FILL };
  const result = (id: string): SpecificationResult => ({ specification: { id, name: id }, status: 'pass', applicableCount: 1, passedCount: 1, failedCount: 0, passRate: 100, entityResults: [] });
  const live: ValidationReport = {
    source: { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [] } }, modelInfo: [], timestamp: new Date('2026-02-01T00:00:00.000Z'),
    summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
    specificationResults: [result('r1')],
  };
  const editor = (block: DocumentBlock, onChange: (b: DocumentBlock) => void) =>
    render(<BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={live} onChange={onChange} onMove={noop} onCopy={noop} onRemove={noop} />);

  it('refreshing from the live report keeps the heading text, size, ink and background', () => {
    const changes: DocumentBlock[] = [];
    const ui = editor(styled, (b) => changes.push(b));
    const refresh = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'));
    assert.ok(refresh, 'the refresh button is present');
    click(refresh);
    assert.equal(changes.length, 1);
    assert.deepEqual(blockTitleFields(changes[0] as IdsReportBlock), blockTitleFields(styled));
  });

  it('a refresh and a saved-source choice keep the heading style and specificationsOnly on the same compact block', () => {
    const block: IdsReportBlock = { ...styled, variant: 'compact', specificationsOnly: true };
    const entry = { id: 'saved-2', name: 'Saved run', snapshot: { ...idsBlock, id: 'saved-snapshot', specificationsOnly: false } };
    useViewerStore.setState({ savedValidationReports: [entry] });
    const refreshed: DocumentBlock[] = [];
    const first = editor(block, (b) => refreshed.push(b));
    click([...first.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'))!);
    cleanup();
    const chosen: DocumentBlock[] = [];
    const second = editor(block, (b) => chosen.push(b));
    selectOption([...second.querySelectorAll<HTMLSelectElement>('select')].find((el) => [...el.options].some((o) => o.value === 'saved:saved-2'))!, 'saved:saved-2');
    for (const result of [refreshed[0], chosen[0]] as IdsReportBlock[]) {
      assert.deepEqual(blockTitleFields(result), blockTitleFields(block));
      assert.equal(result.specificationsOnly, true, 'the compact layout option survives with the heading style');
      assert.equal(result.variant, 'compact');
    }
  });

  it('changing the report layout and toggling the benchmarks keep the heading style', () => {
    const changes: DocumentBlock[] = [];
    const ui = editor(styled, (b) => changes.push(b));
    const variant = ui.querySelector<HTMLSelectElement>('select[aria-label="IDS report layout"]');
    assert.ok(variant, 'the layout selector is present');
    selectOption(variant, 'long');
    assert.equal((changes[0] as IdsReportBlock).variant, 'long');
    assert.deepEqual(blockTitleFields(changes[0] as IdsReportBlock), blockTitleFields(styled));
  });

  it('choosing a saved report keeps the heading style of the block and does not take the saved copy\'s own', () => {
    const entry = { id: 'saved-1', name: 'Saved run', snapshot: { ...idsBlock, id: 'saved-snapshot', titleFontSize: 7, titleBackgroundColor: '#000000' } };
    useViewerStore.setState({ savedValidationReports: [entry] });
    const changes: DocumentBlock[] = [];
    const ui = editor(styled, (b) => changes.push(b));
    const source = [...ui.querySelectorAll<HTMLSelectElement>('select')].find((el) => [...el.options].some((o) => o.value === 'saved:saved-1'));
    assert.ok(source, 'the saved report picker is present');
    selectOption(source, 'saved:saved-1');
    assert.equal(changes.length, 1);
    const chosen = changes[0] as IdsReportBlock;
    assert.equal(chosen.savedReportId, 'saved-1');
    assert.deepEqual(blockTitleFields(chosen), blockTitleFields(styled), 'the destination block keeps its own heading style');
  });
});
