/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { documentPreviewReady } from '@/test/document-preview';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { tableTitle } from '@/lib/document/generate-document-pdf';
import { BLOCK_GAP, composeDocument, estimateTextWidth } from '@/lib/document/compose';
import { IfcTypeEnum } from '@ifc-lite/data';
import { validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { runRuleSet, type RuleSetFile } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render, click, type as typeInput, waitFor } from '@/test/render';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { validationReportSnapshot } from '@/lib/validation/reports/history';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec } from '@/lib/document/types';
import { DocumentPanel } from './DocumentPanel';

// Committed SketchUp 2024 model, not a hand-invented model result (#6547).
const sample = new URL('../../../../public/samples/building-architecture.ifc', import.meta.url);
const originalIds: IDSDocument = { info: { title: 'Original IDS source' }, specifications: [{
  id: 'wall-name', name: 'Wall Name exists', ifcVersions: ['IFC4'],
  applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
  requirements: [{ id: 'name', optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } } }],
}] };
const originalRules: RuleSetFile = { version: 1, name: 'Original information source', rules: [{
  id: 'wall-names', name: 'Wall names are unique',
  applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'unique', subject: { kind: 'attribute', name: 'Name' } },
}] };
const originalState = useViewerStore.getState();
let spec: DocumentSpec;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); await documentPreviewReady(); };

beforeEach(async () => {
  localStorage.clear();
  const bytes = await readFile(sample);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = { ...fixtureModel('m'), name: 'building-architecture.ifc', sourceFingerprint: 'sample-sketchup', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(model), documents: [], activeDocumentId: null, dashboards: [],
    selectedEntityIds: new Set(), mutationViews: new Map(), mutationVersion: 0,
    bcfProject: { version: '3.0', topics: new Map([['topic', { guid: 'topic', title: 'Original topic source', description: 'Wall coordination', viewpoints: [], comments: [] }]]) },
    savedValidationReports: [] });
  const ids = await validateIDS(originalIds, createDataAccessor(store, model.id),
    { modelId: model.id, schemaVersion: store.schemaVersion, entityCount: store.entityCount }, { includePassingEntities: true });
  const rules = await runRuleSet({ ruleSet: originalRules, models: evaluatorModelsFromState(useViewerStore.getState()), definedModelTagIds: new Set() });
  assert.equal(ids.summary.totalEntitiesChecked, 4);
  assert.equal(rules.summary.totalEntitiesChecked, 4);
  useViewerStore.setState({ idsValidationReport: ids });
  const image = await readFile(new URL('../../../../public/favicon-16x16-cropped.png', import.meta.url));
  spec = { version: DOCUMENT_VERSION, id: 'titles', name: 'Block titles', page: { size: 'A4', orientation: 'portrait' }, blocks: [
    { kind: 'text', id: 'text', text: 'Public SketchUp model notes', style: 'body' },
    { kind: 'image', id: 'image', dataUrl: `data:image/png;base64,${image.toString('base64')}`, height: 40, align: 'left', caption: 'Original image caption' },
    { kind: 'chart', id: 'chart', chart: { id: 'chart-source', title: 'Original chart source', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, height: 120 },
    { kind: 'topic', id: 'topic-block', guid: 'topic', snapshot: false },
    { kind: 'table', id: 'table', source: { kind: 'list', list: { id: 'list-source', name: 'Original table source', createdAt: 1, updatedAt: 1,
      entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
    { ...validationReportSnapshot(ids, useViewerStore.getState().models, 'ids'), variant: 'compact' },
    { ...validationReportSnapshot(rules, useViewerStore.getState().models, 'rules'), variant: 'long' },
    manualReportBlockFromChecklist({ checklist: { version: CHECKLIST_VERSION, name: 'Original checklist source', groups: [{ id: 'group', name: 'Name review', items: [{ id: 'check', text: 'Review wall names' }] }] },
      answers: { check: { status: 'pass', updatedAt: 1 } }, now: new Date(0) }, 'manual'),
  ] };
  useViewerStore.setState({ documents: [spec], activeDocumentId: spec.id });
});
afterEach(() => { cleanup(); useViewerStore.setState(originalState); });

describe('Document content-block title overrides (#6547)', () => {
  it('edits every content heading through mounted controls, persists/reloads it, and preserves source names', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    for (const block of spec.blocks) {
      const editor = ui.querySelector(`[data-block-editor="${block.id}"]`);
      assert.ok(editor);
      const title = editor.querySelector<HTMLInputElement>(`input[aria-label="${block.kind === 'table' ? 'Table title' : 'Block title'}"]`);
      assert.ok(title, `${block.kind} exposes an editable title`);
      typeInput(title, `Authored ${block.id} heading`);
      await settle();
      const preview = ui.querySelector(`[data-preview-block="${block.id}"]`);
      assert.ok(preview?.textContent?.includes(`Authored ${block.id} heading`), `${block.kind} renders the authored heading`);
    }
    const saved = (await loadDocuments()).find((d) => d.id === spec.id);
    assert.ok(saved);
    const imported = parseDocumentFile(JSON.stringify(saved));
    cleanup();
    act(() => useViewerStore.setState({ documents: [imported], activeDocumentId: imported.id }));
    const reopened = render(<DocumentPanel />);
    await settle();
    for (const block of spec.blocks) assert.ok(reopened.textContent?.includes(`Authored ${block.id} heading`), 'file reload retains authored titles');
    const chart = imported.blocks.find((b) => b.kind === 'chart');
    assert.ok(chart?.kind === 'chart'); assert.equal(chart.chart.title, 'Original chart source');
    const ids = imported.blocks.find((b) => b.kind === 'ids-report' && b.sourceKind === 'ids');
    assert.ok(ids?.kind === 'ids-report'); assert.equal(ids.sourceName, 'Original IDS source');
    const manual = imported.blocks.find((b) => b.kind === 'manual-report');
    assert.ok(manual?.kind === 'manual-report'); assert.equal(manual.checklistName, 'Original checklist source');
    const image = imported.blocks.find((b) => b.kind === 'image');
    assert.ok(image?.kind === 'image'); assert.equal(image.caption, 'Original image caption');
  });

  it('clearing a title restores the original heading without changing its chart source', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    const editor = ui.querySelector('[data-block-editor="chart"]'); assert.ok(editor);
    const title = editor.querySelector<HTMLInputElement>('input[aria-label="Block title"]'); assert.ok(title);
    typeInput(title, 'Temporary chart heading'); await settle();
    typeInput(title, '   '); await settle();
    await waitFor(() => !!ui.querySelector('[data-preview-block="chart"]')?.textContent?.includes('Original chart source'), 'cleared title restores the original heading');
    assert.equal((await loadDocuments())[0].blocks.find((b) => b.kind === 'chart')?.chart.title, 'Original chart source');
  });
  it('rejects non-string imported headings for every content kind and accepts existing v10 documents unchanged', () => {
    assert.deepEqual(validateDocumentSpec(spec), []);
    const imported = parseDocumentFile(JSON.stringify(spec));
    assert.equal(imported.version, DOCUMENT_VERSION);
    assert.equal(imported.blocks.length, spec.blocks.length);
    assert.ok(imported.blocks.every((block) => !('title' in block)), 'old documents add no heading overrides');
    const table = spec.blocks.find((block) => block.kind === 'table'); assert.ok(table?.kind === 'table');
    assert.equal(tableTitle({ ...table, title: ' First line\nSecond line ' }), 'First line\nSecond line', 'existing table headings retain their line-break behavior');
    for (const block of spec.blocks) {
      const errors = validateDocumentSpec({ ...spec, blocks: [{ ...block, title: 42 }] });
      assert.ok(errors.some((error) => error.path === 'blocks[0].title'), `${block.kind} validates the optional heading`);
      assert.throws(() => parseDocumentFile(JSON.stringify({ ...spec, blocks: [{ ...block, title: 42 }] })));
    }
  });

  it('keeps authored headings when refreshing an actual IDS snapshot and selecting a saved report of another kind', async () => {
    const ui = render(<DocumentPanel />); await settle();
    const editor = ui.querySelector('[data-block-editor="ids"]'); assert.ok(editor);
    const title = editor.querySelector<HTMLInputElement>('input[aria-label="Block title"]'); assert.ok(title);
    typeInput(title, 'Independent audit heading');
    const refresh = [...editor.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current validation report'); assert.ok(refresh);
    click(refresh); await settle();
    assert.ok(ui.querySelector('[data-preview-block="ids"]')?.textContent?.includes('Independent audit heading'));
    const manual = spec.blocks.find((block) => block.kind === 'manual-report'); assert.ok(manual?.kind === 'manual-report');
    (await act(async () => { (await useViewerStore.getState().saveValidationReport(manual)); }));
    const savedId = useViewerStore.getState().savedValidationReports[0]?.id;
    assert.ok(savedId);
    const source = editor.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]'); assert.ok(source);
    act(() => { source.value = `saved:${savedId}`; source.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
    const replaced = (await loadDocuments())[0].blocks.find((block) => block.id === 'ids');
    assert.ok(replaced?.kind === 'manual-report'); assert.equal(replaced.title, 'Independent audit heading');
    assert.equal(replaced.checklistName, 'Original checklist source');
    assert.ok(ui.querySelector('[data-preview-block="ids"]')?.textContent?.includes('Independent audit heading'));
  });

  it('reserves heading space before text/image content, keeps headings with content, and respects both page and half-column bounds', () => {
    const layout = composeDocument({ name: 'Bounds', page: spec.page, generatedAt: '', measure: estimateTextWidth, blocks: [
      { kind: 'spacer', id: 'space', height: 670 },
      { kind: 'text', id: 'text', title: 'Text heading', style: 'body', text: 'First line\nSecond line' },
      { kind: 'image', id: 'image', title: 'Image heading', height: 1000, align: 'left', aspect: 1, caption: 'Caption' },
      { kind: 'text', id: 'half-a', title: 'A very long half-column heading '.repeat(20), style: 'body', text: 'Half A', width: 'half' },
      { kind: 'text', id: 'half-b', title: 'Half B heading', style: 'body', text: 'Half B', width: 'half' },
    ] });
    const textPage = layout.pages.find((page) => page.items.some((item) => item.kind === 'text' && item.text === 'Text heading')); assert.ok(textPage);
    assert.ok(textPage.items.some((item) => item.kind === 'text' && item.text === 'First line'), 'heading and first body line stay together');
    const items = layout.pages.flatMap((page) => page.items);
    const image = items.find((item) => item.kind === 'image'); assert.ok(image?.kind === 'image');
    const imagePage = layout.pages.find((page) => page.items.includes(image)); assert.ok(imagePage);
    const imageHeading = imagePage.items.find((item) => item.kind === 'text' && item.text === 'Image heading'); assert.ok(imageHeading?.kind === 'text');
    assert.ok(image.y > imageHeading.y, 'title does not overlap the image');
    for (const item of items) if (item.kind === 'text') assert.ok(item.y <= layout.size.h - 64, 'all text stays above the footer');
    const halfHeading = items.find((item) => item.kind === 'text' && item.text.startsWith('A very long')); assert.ok(halfHeading?.kind === 'text');
    assert.ok(halfHeading.text.endsWith('…'));
    assert.ok(estimateTextWidth(halfHeading.text, halfHeading.size, halfHeading.bold) <= (layout.size.w - 90) / 2);
  });


  it('retains the complete authored topic heading as a tooltip beside its real snapshot and restores the source heading when cleared (#6547 preview review)', async () => {
    const png = await readFile(new URL('../../../../public/favicon-16x16-cropped.png', import.meta.url));
    const snapshot = `data:image/png;base64,${png.toString('base64')}`;
    const topic = useViewerStore.getState().bcfProject?.topics.get('topic'); assert.ok(topic);
    const block = spec.blocks.find((entry) => entry.kind === 'topic'); assert.ok(block?.kind === 'topic');
    act(() => useViewerStore.setState({
      bcfProject: { version: '3.0', topics: new Map([['topic', { ...topic, viewpoints: [{ guid: 'snapshot', snapshot }] }]]) },
      documents: [{ ...spec, blocks: [{ ...block, snapshot: true }] }],
    }));
    const ui = render(<DocumentPanel />); await settle();
    const input = ui.querySelector<HTMLInputElement>('input[aria-label="Block title"]'); assert.ok(input);
    const title = 'IFCWALL_COORDINATION_'.repeat(40);
    typeInput(input, title); await settle();
    const preview = ui.querySelector('[data-preview-block="topic-block"]'); assert.ok(preview);
    const heading = [...preview.querySelectorAll<HTMLElement>('span')].find((element) => element.style.fontWeight === '700');
    assert.ok(heading); assert.ok(heading.textContent?.trimEnd().endsWith('…'), 'the canonical heading glyphs stay bounded beside the snapshot');
    assert.equal(preview.getAttribute('title'), title, 'the complete authored heading remains available on its selectable block');
    assert.equal(heading.getAttribute('title'), null, 'truncated glyphs do not mask the complete inherited authored tooltip');
    assert.equal(preview.querySelector('img')?.getAttribute('src'), snapshot, 'the real PNG snapshot remains visible');
    typeInput(input, ''); await settle();
    const fallbackPreview = ui.querySelector('[data-preview-block="topic-block"]'); assert.ok(fallbackPreview);
    const fallback = [...fallbackPreview.querySelectorAll('span')].find((element) => element.textContent?.trimEnd() === topic.title);
    assert.ok(fallback); assert.equal(fallback.getAttribute('title'), null, 'ordinary source heading retains its existing attributes');
    assert.equal(useViewerStore.getState().bcfProject?.topics.get('topic')?.title, topic.title, 'authoring never renames the source');
  });

  it('bounds a long authored topic heading to the text column beside its snapshot (#6547 review)', () => {
    const title = 'Authored coordination heading '.repeat(30);
    const block = { kind: 'topic' as const, id: 'snapshot-topic', title, lines: ['Snapshot context'], snapshotAspect: 4 / 3 };
    const input = { name: 'Topic bounds', page: spec.page, generatedAt: '', measure: estimateTextWidth, blocks: [block] };
    const items = composeDocument(input).pages.flatMap((page) => page.items);
    const snapshot = items.find((item) => item.kind === 'topic-snapshot'); assert.ok(snapshot?.kind === 'topic-snapshot');
    const heading = items.find((item) => item.kind === 'text' && item.bold); assert.ok(heading?.kind === 'text');
    assert.ok(heading.text.endsWith('…'));
    const headingEnd = heading.x + estimateTextWidth(heading.text, heading.size, heading.bold);
    assert.ok(headingEnd <= snapshot.x - BLOCK_GAP, `authored title endpoint ${headingEnd} stays before snapshot column ${snapshot.x - BLOCK_GAP}`);
  });

});
