/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, click, type, waitFor, cleanup } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store/index.js';
import { newChartSpec } from '@/lib/charts/presets.js';
import { LIST_PRESETS } from '@/lib/lists';
import { modelBindingPath } from '@/lib/document/binding-path.js';
import { emptyManualReportBlock } from '@/lib/document/manual-report.js';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence.js';
import { DOCUMENT_VERSION, listCopyForDocument, validateDocumentSpec, type DocumentBlock, type DocumentSpec } from '@/lib/document/types.js';
import { DocumentPanel } from './DocumentPanel.js';

async function parsedModel(id: string, name: string, project: string): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('t','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'${project}',$,$,$,$,$,$);
#41=IFCWALL('0Wall00000000000000041',$,'Wall',$,$,$,$,$,$);
ENDSEC; END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id, { idOffset: federationRegistry.registerModel(id, 41) }), name, ifcDataStore: store, maxExpressId: 41 };
}
const binding = modelBindingPath('Structure.ifc', 'IfcProject.Name');
const textBlock = (): DocumentBlock => ({ kind: 'text', id: 'original', style: 'body', text: `{${binding}}`, title: 'Coordination', textColor: '#123456', width: 'half' });
const cases: DocumentBlock[] = [
  textBlock(),
  { kind: 'image', id: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LdsAAAAASUVORK5CYII=', height: 60, align: 'center', caption: 'Logo' },
  { kind: 'chart', id: 'chart', chart: newChartSpec(), snapshot: false, title: 'Counts', height: 180 },
  { kind: 'topic', id: 'topic', guid: '0bcf-topic-source', snapshot: true, title: 'Open topic' },
  { kind: 'spacer', id: 'spacer', height: 24 },
  { kind: 'page-break', id: 'break' },
  { kind: 'table', id: 'table', source: { kind: 'list', list: listCopyForDocument(LIST_PRESETS[0], 'embedded-list'), fromListId: LIST_PRESETS[0].id }, maxRows: 12, title: 'Walls' },
  { kind: 'table', id: 'validation-table', source: { kind: 'validation', ruleId: 'delivery-rule-source', rows: 'failed', columns: ['name', 'globalId'] }, maxRows: 8, title: 'Validation source' },
  { kind: 'ids-report', id: 'ids', sourceName: 'Delivery', generatedAt: new Date(0).toISOString(), savedReportId: 'saved-ids-source', summary: { checked: 0, passed: 0, failed: 0, passRate: 100 }, checks: [], title: 'Saved checks' },
  { ...emptyManualReportBlock('manual', new Date(0)), checklistName: 'Fire checks', checklistId: 'checklist-source', modelFingerprint: 'model-source', savedReportId: 'saved-manual-source', summary: { total: 1, pass: 1, fail: 0, warning: 0, unanswered: 0 }, groups: [{ id: 'fire', name: 'Fire', counts: { total: 1, pass: 1, fail: 0, warning: 0, unanswered: 0 }, items: [{ id: 'checked-door', text: 'Check door', status: 'pass', comment: 'Recorded evidence' }] }] },
];
function spec(blocks: DocumentBlock[]): DocumentSpec {
  return { version: DOCUMENT_VERSION, id: 'copy-document', name: 'Coordination', page: { size: 'A4', orientation: 'portrait' }, blocks };
}
async function mount(block: DocumentBlock): Promise<HTMLElement> {
  const document = spec([structuredClone(block), { kind: 'text', id: 'tail', text: 'Following content', style: 'body' }]);
  assert.deepEqual(validateDocumentSpec(document), []);
  await act(async () => {
    assert.equal(await useViewerStore.getState().upsertDocument(document), true);
    useViewerStore.getState().setActiveDocumentId(document.id);
  });
  return render(<DocumentPanel />);
}
function copyButton(ui: HTMLElement, id: string): HTMLButtonElement {
  const button = ui.querySelector<HTMLButtonElement>(`[data-block-editor="${id}"] button[aria-label="Copy block"]`);
  assert.ok(button, `missing actual Copy block action for ${id}`);
  return button;
}
async function committed(): Promise<DocumentSpec> {
  await waitFor(() => useViewerStore.getState().documentsStorage.items['copy-document'] === 'saved', 'real document transaction must commit');
  const saved = (await loadDocuments()).find(document => document.id === 'copy-document');
  assert.ok(saved);
  return saved;
}
/** Re-identify only owned ids when comparing content; source references are part of the invariant. */
function authoredContent(block: DocumentBlock): DocumentBlock {
  const content = structuredClone(block);
  content.id = 'owned-block';
  if (content.kind === 'chart') content.chart.id = 'owned-chart';
  if (content.kind === 'table' && content.source.kind === 'list') content.source.list.id = 'owned-list';
  return content;
}
function ownedIds(blocks: DocumentBlock[]): string[] {
  return blocks.flatMap(block => [block.id, ...(block.kind === 'chart' ? [block.chart.id] : []),
    ...(block.kind === 'table' && block.source.kind === 'list' ? [block.source.list.id] : [])]);
}

describe('DocumentPanel copies every authored block (#6689)', () => {
  beforeEach(async () => {
    federationRegistry.clear();
    const a = await parsedModel('a', 'Architecture.ifc', 'Architecture');
    const b = await parsedModel('b', 'Structure.ifc', 'Structure');
    useViewerStore.setState({ models: new Map([[a.id, a], [b.id, b]]), activeModelId: a.id, dashboards: [], listDefinitions: [], bcfProject: null, idsValidationReport: null, selectedEntityIds: new Set(), mutationViews: new Map(), mutationVersion: 0 });
  });
  afterEach(() => { cleanup(); federationRegistry.clear(); });

  for (const block of cases) it(`copies ${block.kind} (${block.id}) immediately after its source with independent owned ids and durable authored content`, async () => {
    const ui = await mount(block);
    click(copyButton(ui, block.id));
    const current = useViewerStore.getState().documents[0];
    assert.equal(current.blocks.length, 3);
    const copied = current.blocks[1];
    assert.equal(current.blocks[0].id, block.id);
    assert.equal(current.blocks[2].id, 'tail');
    assert.notEqual(copied.id, block.id);
    assert.deepEqual(authoredContent(copied), authoredContent(block));
    assert.equal(new Set(ownedIds(current.blocks)).size, ownedIds(current.blocks).length, 'owned block/chart/list ids never collide');
    const editor = ui.querySelector(`[data-block-editor="${copied.id}"]`);
    assert.ok(editor);
    assert.ok(editor.parentElement?.classList.contains('ring-sky-500'), 'the new copy is selected for editing');
    const saved = await committed();
    assert.deepEqual(saved.blocks, current.blocks);
    const imported = parseDocumentFile(JSON.stringify(saved));
    assert.deepEqual(imported.blocks.map(authoredContent), saved.blocks.map(authoredContent), 'export/import preserves source bindings and evidence');
    const existing = new Set(ownedIds(saved.blocks));
    assert.ok(ownedIds(imported.blocks).every(id => !existing.has(id)), 'import gives independent owned ids too');
  });

  it('retains scoped model fields through copy, separate editing, deletion and persistence', async () => {
    const ui = await mount(textBlock());
    click(copyButton(ui, 'original'));
    const copied = useViewerStore.getState().documents[0].blocks[1];
    await waitFor(() => ui.querySelector(`[data-preview-block="${copied.id}"] [data-block-text]`)?.textContent === 'Coordination\nStructure', 'copy retains its authored heading and resolves its Structure source');
    act(() => useViewerStore.setState({ activeModelId: 'b' }));
    act(() => useViewerStore.setState({ activeModelId: 'a' }));
    const textarea = ui.querySelector<HTMLTextAreaElement>(`[data-block-editor="${copied.id}"] textarea`);
    assert.ok(textarea);
    type(textarea, `Copied {${binding}}`);
    await waitFor(() => ui.querySelector(`[data-preview-block="${copied.id}"] [data-block-text]`)?.textContent === 'Coordination\nCopied Structure', 'edited copy renders independently and retains its heading');
    assert.equal(ui.querySelector('[data-preview-block="original"] [data-block-text]')?.textContent, 'Coordination\nStructure');
    const saved = await committed();
    assert.ok(saved.blocks[0].kind === 'text' && saved.blocks[1].kind === 'text');
    assert.equal(saved.blocks[0].text, `{${binding}}`);
    assert.equal(saved.blocks[1].text, `Copied {${binding}}`);
    const remove = ui.querySelector(`[data-block-editor="${copied.id}"] button[aria-label="Remove block"]`);
    assert.ok(remove);
    click(remove);
    assert.equal((await committed()).blocks[0].id, 'original');
    assert.equal(ui.querySelector('[data-preview-block="original"] [data-block-text]')?.textContent, 'Coordination\nStructure');
  });

  it('does not share nested chart, list or report payloads between mounted copies', async () => {
    for (const original of cases.filter(block => ['chart', 'table', 'manual-report'].includes(block.kind))) {
      const ui = await mount(original);
      click(copyButton(ui, original.id));
      const [source, copied] = useViewerStore.getState().documents[0].blocks;
      assert.ok(source.kind === copied.kind);
      if (source.kind === 'chart' && copied.kind === 'chart') {
        assert.notEqual(source.chart, copied.chart);
        assert.notEqual(source.chart.measure, copied.chart.measure);
      } else if (source.kind === 'table' && copied.kind === 'table' && source.source.kind === 'list' && copied.source.kind === 'list') {
        assert.notEqual(source.source.list.columns, copied.source.list.columns);
        assert.notEqual(source.source.list.groups, copied.source.list.groups);
        assert.equal(source.source.fromListId, copied.source.fromListId);
      } else if (source.kind === 'table' && copied.kind === 'table' && source.source.kind === 'validation' && copied.source.kind === 'validation') {
        assert.notEqual(source.source.columns, copied.source.columns);
        assert.equal(copied.source.ruleId, 'delivery-rule-source');
      } else if (source.kind === 'manual-report' && copied.kind === 'manual-report') {
        assert.notEqual(source.groups[0].items, copied.groups[0].items);
        assert.notEqual(source.summary, copied.summary);
        assert.equal(copied.groups[0].items[0].comment, 'Recorded evidence');
      }
      await committed();
      cleanup();
    }
  });

  it('whole-document duplication shares fresh nested identities and keeps source bindings', async () => {
    const chart = cases.find(block => block.kind === 'chart');
    const table = cases.find(block => block.kind === 'table');
    assert.ok(chart && table);
    const ui = await mount(chart);
    await act(async () => { assert.equal(await useViewerStore.getState().upsertDocument(spec([chart, table])), true); });
    const trigger = ui.querySelector('button[aria-label="Document actions"]');
    assert.ok(trigger);
    act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    click(trigger);
    const duplicate = [...document.body.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Duplicate');
    assert.ok(duplicate);
    click(duplicate);
    await waitFor(() => useViewerStore.getState().documents.length === 2 && useViewerStore.getState().activeDocumentId !== 'copy-document', 'Duplicate activates its committed document');
    const documents = await loadDocuments();
    assert.equal(documents.length, 2);
    const [original, copied] = documents;
    assert.notEqual(original.id, copied.id);
    assert.deepEqual(original.blocks.map(authoredContent), copied.blocks.map(authoredContent));
    const allIds = ownedIds(documents.flatMap(entry => entry.blocks));
    assert.equal(new Set(allIds).size, allIds.length, 'whole-document copies also own their nested identities');
  });

  it('retains consecutive real copy clicks instead of overwriting a pending save', async () => {
    const ui = await mount(textBlock());
    const button = copyButton(ui, 'original');
    act(() => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const saved = await committed();
    assert.equal(saved.blocks.length, 4);
    assert.equal(new Set(ownedIds(saved.blocks)).size, 4);
    assert.equal(ui.querySelectorAll('[data-block-editor]').length, 4);
    assert.deepEqual(saved.blocks.slice(0, 3).map(authoredContent), Array.from({ length: 3 }, () => authoredContent(textBlock())));
  });

  it('keeps a visible unsaved copy after an actual refused IndexedDB transaction and saves it on retry', async () => {
    const ui = await mount(textBlock());
    const refusal = refuseContentWrites();
    try {
      click(copyButton(ui, 'original'));
      await waitFor(() => useViewerStore.getState().documentsStorage.items['copy-document'] === 'quota', 'actual database refusal must be reported');
      assert.equal(ui.querySelectorAll('[data-block-editor]').length, 3);
      assert.match(ui.querySelector('[data-content-storage] [role="alert"]')?.textContent ?? '', /Browser storage is full/);
      assert.equal((await loadDocuments())[0].blocks.length, 2, 'failed transaction never pretends the copy is durable');
    } finally { refusal.mock.restore(); }
    const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry save');
    assert.ok(retry);
    click(retry);
    assert.equal((await committed()).blocks.length, 3);
  });
});
