/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { captureEvidence } from './evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from './conversation';
import { prepareReportDraft, saveReportDraft, isReportDraftCurrent } from './report-draft';
import { validateDocumentSpec } from '../document/types';
import { renderTemplate, templatePaths } from '../document/bindings';
import { readContentRows } from '../storage/content-database';
import { openConversation } from './library';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); mock.restoreAll(); });
function discussion(answer = 'Inspect the estimated -0.02 distance [E1]. Literal {Model.Name} remains captured.', count = 120) {
  const clashes: Clash[] = Array.from({ length: count }, (_, i) => ({ id: `c${i}`,
    a: { key: `a${i}`, ref: i + 1, model: 'a', tag: 'IfcWall' }, b: { key: `b${i}`, ref: i + 501, model: 'a', tag: 'IfcPipeSegment' },
    rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'estimate',
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } }));
  const result = stampAnalysisReport({ clashes, summary: summarizeClashes(clashes), rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true } }, captureAnalysisStamp(true));
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  replaceEvidence(captureEvidence('clash'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Prepare a report' }, { role: 'assistant', model: 'actual-provider', content: answer }] });
}

// #6830: native document compatibility, historical values and literal binding safety are the invariants.
test('native report preserves complete sample coverage and literal text after source replacement', () => {
  discussion();
  const draft = prepareReportDraft('Coordination {Model.Name}');
  assert.deepEqual(validateDocumentSpec(JSON.parse(JSON.stringify(draft.document))), []);
  const blocks = draft.document.blocks.filter(block => block.kind === 'text');
  assert.ok(blocks.every(block => templatePaths(block.text).length === 0));
  const rendered = blocks.map(block => renderTemplate(block.text, { models: [], activeModelId: null, today: new Date() }).text).join('\n');
  assert.match(rendered, /100 of 120 native rows/);
  assert.match(rendered, /unseen findings are not evaluated/);
  assert.match(rendered, /actual-provider/);
  assert.match(rendered, /Literal \{Model.Name\} remains captured/);
  // Readable appendix: every included row on one line with its native facts, no raw JSON dump.
  assert.match(rendered, /^E1\s+IfcWall vs IfcPipeSegment · hard · major · -0\.02 m \(estimate\) · disciplines ARCH\/STR vs MEP\/FIRE · a0 vs b0$/m);
  assert.match(rendered, /^E100\s+IfcWall vs IfcPipeSegment/m);
  assert.doesNotMatch(rendered, /^E101\s/m);
  assert.doesNotMatch(rendered, /"citation":/);
  assert.deepEqual(draft.citations, ['E1']);
  const frozen = JSON.stringify(draft.document);
  useViewerStore.setState({ clashResult: null, clashRawResult: null });
  assert.equal(isReportDraftCurrent(draft), false);
  assert.equal(JSON.stringify(draft.document), frozen);
});

test('unknown citations, incomplete answers and changed review content cannot save', async () => {
  discussion('Finding [E101]');
  assert.throws(() => prepareReportDraft('Report'), /Unknown evidence citations/);
  discussion();
  useAssistant.setState({ status: 'error', error: 'truncated-output' });
  assert.throws(() => prepareReportDraft('Report'), /completed analysis answer/);
  discussion();
  const draft = prepareReportDraft('Report');
  draft.document.name = 'Unreviewed overwrite';
  await assert.rejects(saveReportDraft(draft, draft.documentJson), /changed/);
  const fresh = prepareReportDraft('Report');
  useAssistant.setState({ messages: [...useAssistant.getState().messages,
    { role: 'user', content: 'New turn' }, { role: 'assistant', model: 'other-provider', content: 'New answer' }] });
  await assert.rejects(saveReportDraft(fresh, fresh.documentJson), /changed/);
});

test('actual document storage refusal retains the reviewed draft for native retry', async () => {
  discussion();
  const draft = prepareReportDraft('Refusal recovery');
  await useViewerStore.getState().initializeDocuments();
  const transaction = IDBDatabase.prototype.transaction;
  const refused = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readwrite' && stores === 'items') throw new DOMException('Quota exhausted', 'QuotaExceededError');
    return transaction.call(this, stores, mode, options);
  });
  assert.equal(await saveReportDraft(draft, draft.documentJson), false);
  assert.equal(useViewerStore.getState().documentsStorage.items[draft.document.id], 'quota');
  assert.equal(JSON.stringify(useViewerStore.getState().documents.find(doc => doc.id === draft.document.id)), draft.documentJson);
  refused.mock.restore();
  assert.equal(await useViewerStore.getState().retryDocumentsSave(), true);
  const stored = (await readContentRows('document')).find(row => row.id === draft.document.id);
  assert.ok(stored);
});

test('document initialization cannot retarget a reviewed discussion (#6830)', async () => {
  discussion();
  const draft = prepareReportDraft('Race refusal');
  useViewerStore.setState({ initializeDocuments: async () => {
    useAssistant.setState({ messages: [...useAssistant.getState().messages,
      { role: 'user', content: 'Replacement question' }, { role: 'assistant', model: 'replacement', content: 'Replacement answer' }] });
    return true;
  } });
  await assert.rejects(saveReportDraft(draft, draft.documentJson), /changed while document storage initialized/);
  assert.equal(useViewerStore.getState().documents.some(doc => doc.id === draft.document.id), false);
});

test('archived discussions create historical documents after their native source is gone (#6830)', () => {
  discussion();
  const source = prepareReportDraft('Original').source;
  useViewerStore.setState({ clashResult: null, clashRawResult: null });
  openConversation(source);
  const draft = prepareReportDraft('Archived report');
  assert.equal(draft.historical, true);
  assert.equal(isReportDraftCurrent(draft), true);
  const text = draft.document.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n');
  assert.match(text, /Captured evidence is historical/);
  assert.ok(text.includes(source.id));
  assert.ok(text.includes('actual-provider'));
});

test('actual native PDF retains evidence and literal braces against a parsed real model', async () => {
  const { readFile } = await import('node:fs/promises');
  const { IfcParser } = await import('@ifc-lite/parser');
  const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  assert.equal(Array.from(store.entities.expressId).filter(id => store.entities.getTypeName(id) === 'IfcWall').length, 4);
  discussion('Literal {Count[IfcWall]} and source estimate -0.02 [E1].', 1);
  const draft = prepareReportDraft('PDF evidence');
  const { generateDocumentPdf } = await import('../document/generate-document-pdf');
  const { browserReportSeams } = await import('../export/report/generate-report-pdf');
  const jspdf = await import('jspdf');
  const previous = Reflect.get(window, 'jspdf');
  Reflect.set(window, 'jspdf', jspdf);
  let result;
  try {
    result = await generateDocumentPdf({ document: draft.document,
      bindings: { models: [{ id: 'public', name: 'building-architecture.ifc', store }], activeModelId: 'public', today: new Date() },
      aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: async () => { throw new Error('Text-only report must not measure images'); } });
  } finally { Reflect.set(window, 'jspdf', previous); }
  assert.deepEqual(result.unresolved, []);
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const require = createRequire(import.meta.url);
  const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try { pages.push((await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('\n')); }
      finally { page.cleanup(); }
    }
    const text = pages.join('\n');
    assert.match(text, /Literal \{Count\[IfcWall\]\}/);
    assert.match(text, /estimate -0.02 \[E1\]/);
    assert.match(text, /actual-provider/);
    assert.match(text, /1 of 1 native rows/);
    // Standard PDF fonts only: the appendix line must extract as real text, not re-encoded glyphs.
    assert.match(text, /E1\s+IfcWall vs IfcPipeSegment · hard · major · -0\.02 m \(estimate\)/);
    assert.equal(pdf.numPages, result.pages);
  } finally { await task.destroy(); }
});
