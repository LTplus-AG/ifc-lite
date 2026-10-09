/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { render, click, cleanup, type } from '@/test/render';
import { parseStep, seedModel } from '@/test/properties-panel-harness';
import { ConversationLibrary } from '@/components/viewer/assistant/ConversationLibrary';
import { ReceiptFooter } from '@/components/viewer/assistant/AssistantUsage';
import { useViewerStore } from '@/store';
import { useRequestReceipts } from '../llm/request-receipts';
import { runModelRequest, createRootBudget } from '../llm/request-service';
import { createContentLibrary, initialContentStatus } from '../storage/content-library';
import { contentTransaction, transactionDone, readContentRows } from '../storage/content-database';
import { createContentBackup, parseContentBackup, importContentBackup } from '../storage/content-backup';
import { captureEvidence } from './evidence';
import { replaceEvidence, cancelAssistant, useAssistant } from './conversation';
import { assistantLibrary, useAssistantLibrary, openConversation } from './library';
import { assistantContent, decodeConversation, type SavedConversation } from './persistence';
import { sendAssistant } from './request';
import { prepareReportDraft, saveReportDraft } from './report-draft';
import { exportDocument, parseDocumentFile, documentContent } from '../document/persistence';
import { planReportRefresh, applyReportRefresh } from './report-refresh';

const initial = useViewerStore.getState(), assistantInitial = useAssistant.getState();
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  const tx = await contentTransaction(['items', 'migrations', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  for (const name of ['items', 'migrations', 'recovery']) tx.objectStore(name).clear();
  await done; localStorage.clear();
  await assistantLibrary.refresh();
});
afterEach(() => {
  cleanup(); cancelAssistant(); globalThis.fetch = originalFetch;
  useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true);
  useRequestReceipts.setState({ receipts: [], inFlight: [] }); mock.restoreAll();
});
async function answer(reported = true) {
  const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await parseStep(bytes); seedModel('native', 0, store, 52);
  assert.equal(store.entities.getTypeName(52), 'IfcSlab');
  replaceEvidence(captureEvidence('selection'));
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
  const frames = [
    { choices: [{ delta: { content: 'Native source element [E1].' }, finish_reason: null }] },
    { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], ...(reported ? { usage: { prompt_tokens: 1234, completion_tokens: 456 } } : {}) },
  ];
  globalThis.fetch = async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
  assert.equal(await sendAssistant('Explain the native element', 'openai/gpt-free', '/api/chat'), true);
  const receipt = useAssistant.getState().messages.at(-1)?.receipt; assert.ok(receipt);
  assert.equal(receipt.usageReported, reported);
  if (receipt.usageReported) { assert.equal(receipt.inputTokens, 1234); assert.equal(receipt.outputTokens, 456); }
  assert.equal(receipt.outcome, 'completed'); return receipt;
}
const generationReceipt = (document: { aiReport?: unknown }): unknown => {
  const record = document.aiReport;
  return record && typeof record === 'object' && 'generationReceipt' in record ? record.generationReceipt : undefined;
};
async function waitFor(saved: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!saved() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(saved(), 'actual native commit must settle');
}

test('#7242 actual IFC/sendAssistant SSE receipt survives mounted Save, native IDB reopen and backup', async () => {
  const receipt = await answer(); await assistantLibrary.initialize();
  const ui = render(<ConversationLibrary />);
  type(ui.querySelector<HTMLInputElement>('#assistant-conversation-name')!, 'Receipted native discussion');
  const save = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Save conversation'); assert.ok(save);
  await act(async () => { click(save); await waitFor(() => Object.values(useAssistantLibrary.getState().status.items).includes('saved')); });
  const rows = await readContentRows('assistant'); assert.equal(rows.length, 1);
  const saved = assistantContent.decode(rows[0].payload); assert.ok(saved);
  assert.deepEqual(saved.messages.at(-1)?.receipt, receipt, 'save must retain the actual parsed transport receipt');
  let entries: SavedConversation[] = [];
  const reopened = createContentLibrary(assistantContent, () => entries, next => { entries = next; });
  await reopened.initialize(); assert.deepEqual(entries[0].messages.at(-1)?.receipt, receipt);
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], assistant: entries })));
  assert.deepEqual(backup.libraries.assistant?.[0].messages.at(-1)?.receipt, receipt);
  cleanup();
  const tx = await contentTransaction(['items'], 'readwrite'), done = transactionDone(tx);
  tx.objectStore('items').clear(); await done;
  assert.equal(await importContentBackup(backup), 1);
  const importedRows = await readContentRows('assistant'); assert.equal(importedRows.length, 1);
  assert.deepEqual(assistantContent.decode(importedRows[0].payload)?.messages.at(-1)?.receipt, receipt);
  useRequestReceipts.setState({ receipts: [], inFlight: [] }); openConversation(entries[0]);
  const historical = useAssistant.getState().messages.at(-1)?.receipt; assert.ok(historical);
  const footer = render(<ReceiptFooter receipt={historical} />);
  assert.match(footer.textContent ?? '', /1,234|1234/);
  assert.equal(useRequestReceipts.getState().receipts.length, 0, 'reopen does not revive global session history');
});

test('#7242 actual report composition, native save/export/reparse and evidence refresh retain final generation receipt', async () => {
  const receipt = await answer(); const draft = prepareReportDraft('Receipted IFC report');
  assert.deepEqual(generationReceipt(draft.document), receipt, 'report must embed its owned final answer receipt');
  assert.equal(await saveReportDraft(draft, draft.documentJson), true);
  const row = (await readContentRows('document')).find(item => item.id === draft.document.id); assert.ok(row);
  assert.deepEqual(generationReceipt(row.payload as { aiReport?: unknown }), receipt);
  let published: Blob | undefined;
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); published = blob; return 'blob:retention-audit'; };
  try { exportDocument(draft.document); } finally { URL.createObjectURL = originalCreate; }
  assert.ok(published); const imported = parseDocumentFile(await published.text());
  assert.notEqual(imported.id, draft.document.id); assert.deepEqual(generationReceipt(imported), receipt);
  await assistantLibrary.put(draft.source.id, draft.source); await assistantLibrary.put(draft.source.id, null);
  const refreshed = applyReportRefresh(imported, planReportRefresh(imported, captureEvidence('selection')));
  assert.deepEqual(generationReceipt(refreshed), receipt, 'native-only refresh never fabricates another model request');
  assert.equal(useRequestReceipts.getState().receipts.length, 1);
});


function nativeLibrary() {
  let entries: SavedConversation[] = [], status = initialContentStatus();
  return { ...createContentLibrary(assistantContent, () => entries, (next, state) => { entries = next; status = state; }),
    entries: () => entries, status: () => status };
}

test('#7242 actual quota refusal/retry and two-tab conflict retain exact generation metadata', async () => {
  const receipt = await answer(); const source = prepareReportDraft('Recovery').source;
  const first = nativeLibrary(); await first.initialize();
  const native = IDBDatabase.prototype.transaction;
  const refused = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readwrite' && stores === 'items') throw new DOMException('Quota exhausted', 'QuotaExceededError');
    return native.call(this, stores, mode, options);
  });
  try {
    assert.equal(await first.put(source.id, source), false);
    assert.equal(first.status().items[source.id], 'quota');
    const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], assistant: first.entries() })));
    assert.deepEqual(backup.libraries.assistant?.[0].messages.at(-1)?.receipt, receipt);
  } finally { refused.mock.restore(); }
  assert.equal(await first.retry(), true);
  const second = nativeLibrary(); await second.initialize();
  assert.equal(await first.put(source.id, { ...source, name: 'New committed name' }), true);
  assert.equal(await second.put(source.id, { ...source, name: 'Other tab draft' }), false);
  assert.equal(second.status().items[source.id], 'conflict');
  assert.deepEqual(second.entries()[0].messages.at(-1)?.receipt, receipt);
  const row = (await readContentRows('assistant')).find(item => item.id === source.id); assert.ok(row);
  const saved = assistantContent.decode(row.payload); assert.ok(saved);
  assert.equal(saved.name, 'New committed name'); assert.deepEqual(saved.messages.at(-1)?.receipt, receipt);
});

test('#7242 provider usage absent and legacy turns/reports stay unknown rather than receiving estimates', async () => {
  const receipt = await answer(false), draft = prepareReportDraft('Unknown provider usage');
  assert.equal(receipt.usageReported, false); assert.equal('inputTokens' in receipt, false);
  const portable = assistantContent.decode(draft.source); assert.ok(portable);
  assert.deepEqual(portable.messages.at(-1)?.receipt, receipt);
  const current = documentContent.decode(draft.document); assert.ok(current);
  assert.deepEqual(generationReceipt(current), receipt);
  const legacy = { ...draft.source, messages: draft.source.messages.map(({ receipt: _receipt, ...message }) => message) };
  const old = decodeConversation(legacy); assert.ok(old); assert.equal(old.messages.at(-1)?.receipt, undefined);
  const legacyDocument = structuredClone(draft.document); assert.ok(legacyDocument.aiReport);
  Reflect.deleteProperty(legacyDocument.aiReport, 'generationReceipt');
  const recovered = documentContent.decode(legacyDocument); assert.ok(recovered);
  assert.equal(generationReceipt(recovered), undefined);
});

test('#7242 portable conversations reconstruct receipt metadata and exclude unknown private transport fields', async () => {
  const receipt = await answer(), draft = prepareReportDraft('Private-field exclusion');
  const hostile = { ...receipt, system: 'PRIVATE_PROMPT', reply: 'PRIVATE_REPLY', outputSchema: { SECRET: 'PRIVATE_SCHEMA' },
    evidence: 'PRIVATE_EVIDENCE', proxyUrl: 'https://private.test/endpoint', apiKey: 'PRIVATE_KEY', error: 'PRIVATE_ERROR' };
  const conversation = decodeConversation({ ...draft.source, messages: [draft.source.messages[0], { ...draft.source.messages[1], receipt: hostile }] });
  assert.ok(conversation); assert.deepEqual(conversation.messages.at(-1)?.receipt, receipt);
});

test('#7242 native document decode/import/export independently exclude private receipt fields', async () => {
  const receipt = await answer(), draft = prepareReportDraft('Document private-field exclusion');
  const hostile = { ...receipt, system: 'PRIVATE_PROMPT', reply: 'PRIVATE_REPLY', outputSchema: { SECRET: 'PRIVATE_SCHEMA' },
    evidence: 'PRIVATE_EVIDENCE', proxyUrl: 'https://private.test/endpoint', apiKey: 'PRIVATE_KEY', error: 'PRIVATE_ERROR' };
  assert.ok(draft.document.aiReport);
  const raw = { ...draft.document, aiReport: { ...draft.document.aiReport, generationReceipt: hostile } };
  const portable = documentContent.decode(raw); assert.ok(portable);
  assert.deepEqual(generationReceipt(portable), receipt);
  assert.deepEqual(generationReceipt(parseDocumentFile(JSON.stringify(raw))), receipt);
  let published: Blob | undefined; const originalCreate = URL.createObjectURL;
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); published = blob; return 'blob:privacy-audit'; };
  try { exportDocument(raw); } finally { URL.createObjectURL = originalCreate; }
  assert.ok(published); const file = JSON.parse(await published.text());
  assert.deepEqual(file.aiReport.generationReceipt, receipt, 'direct native export cannot preserve arbitrary nested metadata');
});

test('#7242 malformed declared receipts are refused instead of silently becoming unknown legacy records', async () => {
  const receipt = await answer(), draft = prepareReportDraft('Malformed metadata'); assert.ok(draft.document.aiReport);
  const invalid = [
    { ...receipt, finishedAt: receipt.startedAt - 1 }, { ...receipt, startedAt: NaN }, { ...receipt, id: '' },
    { ...receipt, model: 'different-model' }, { ...receipt, route: 'https://private.test' }, { ...receipt, outcome: 'success' },
    { ...receipt, usageReported: true, inputTokens: -1 }, { ...receipt, usageReported: true, outputTokens: 0.5 },
    { ...receipt, usageReported: 'yes' }, { ...receipt, outputFormat: 'ignored-schema' },
  ];
  for (const value of invalid) {
    assert.equal(decodeConversation({ ...draft.source, messages: [draft.source.messages[0], { ...draft.source.messages[1], receipt: value }] }), null);
    assert.equal(documentContent.decode({ ...draft.document, aiReport: { ...draft.document.aiReport, generationReceipt: value } }), null);
  }
  assert.equal(decodeConversation({ ...draft.source, messages: [{ ...draft.source.messages[0], receipt }, draft.source.messages[1]] }), null,
    'a user turn cannot claim to own model generation metadata');
});


test('#7242 native document quota retry preserves reviewed identity and its original generation receipt', async () => {
  const receipt = await answer(), draft = prepareReportDraft('Document quota recovery');
  await useViewerStore.getState().initializeDocuments();
  const native = IDBDatabase.prototype.transaction;
  const refused = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (mode === 'readwrite' && stores === 'items') throw new DOMException('Quota exhausted', 'QuotaExceededError');
    return native.call(this, stores, mode, options);
  });
  try {
    assert.equal(await saveReportDraft(draft, draft.documentJson), false);
    const held = useViewerStore.getState().documents.find(document => document.id === draft.document.id); assert.ok(held);
    assert.deepEqual(generationReceipt(held), receipt);
    assert.equal(useViewerStore.getState().documentsStorage.items[draft.document.id], 'quota');
  } finally { refused.mock.restore(); }
  assert.equal(await useViewerStore.getState().retryDocumentsSave(), true);
  const stored = (await readContentRows('document')).find(row => row.id === draft.document.id); assert.ok(stored);
  assert.deepEqual(generationReceipt(stored.payload as { aiReport?: unknown }), receipt);
});

test('#7242 actual typed direct transport protocol survives portable receipt decoding without its schema or credentials', async () => {
  await answer(); const source = prepareReportDraft('Protocol witness').source;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Native protocol witness [E1]."},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\ndata: [DONE]\n\n');
  };
  const outcome = await runModelRequest({ route: { kind: 'openai', model: 'gpt-4.1', apiKey: 'PRIVATE_KEY' },
    proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'PRIVATE_TYPED_PROMPT' }],
    outputSchema: { name: 'receipt_protocol', schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } },
    maxOutputTokens: 100, timeoutMs: 5000, budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }) });
  assert.equal(outcome.kind, 'completed'); assert.ok(outcome.kind === 'completed');
  assert.ok(sent.response_format, 'the actual direct native serializer must send the strict schema');
  assert.equal(outcome.receipt.outputFormat, 'json-schema');
  const decoded = decodeConversation({ ...source, messages: [source.messages[0],
    { role: 'assistant', content: outcome.text, model: outcome.receipt.model, receipt: outcome.receipt }] });
  assert.ok(decoded); assert.deepEqual(decoded.messages.at(-1)?.receipt, outcome.receipt);
  assert.equal(JSON.stringify(decoded.messages.at(-1)?.receipt).includes('PRIVATE'), false);
  assert.equal('outputSchema' in outcome.receipt, false);
});

test('#7242 independent review: conflict restore retains draft receipt on failed read and adopts exact committed receipt on confirmed restore', async () => {
  const committedReceipt = await answer(), committed = prepareReportDraft('Committed generation').source;
  const first = nativeLibrary(), second = nativeLibrary();
  await first.initialize(); assert.equal(await first.put(committed.id, committed), true); await second.initialize();
  const newerReceipt = await answer(), newer = { ...prepareReportDraft('New generation').source, id: committed.id };
  assert.notEqual(newerReceipt.id, committedReceipt.id);
  assert.equal(await first.put(committed.id, newer), true);
  const draft = { ...committed, name: 'Held local draft' };
  assert.equal(await second.put(committed.id, draft), false);
  assert.equal(second.status().items[committed.id], 'conflict');
  assert.deepEqual(second.entries()[0].messages.at(-1)?.receipt, committedReceipt);
  const native = IDBDatabase.prototype.transaction;
  const blocked = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (stores === 'items' && mode === 'readonly') throw new DOMException('Read blocked', 'SecurityError');
    return native.call(this, stores, mode, options);
  });
  try {
    assert.equal(await second.restore(), false);
    assert.equal(second.entries()[0].name, draft.name);
    assert.deepEqual(second.entries()[0].messages.at(-1)?.receipt, committedReceipt);
    assert.equal(second.status().items[committed.id], 'conflict');
  } finally { blocked.mock.restore(); }
  assert.equal(await second.restore(), true);
  assert.equal(second.entries()[0].name, newer.name);
  assert.deepEqual(second.entries()[0].messages.at(-1)?.receipt, newerReceipt);
  assert.deepEqual(Object.keys(second.status().items), []);
  const saved = assistantContent.decode((await readContentRows('assistant'))[0].payload); assert.ok(saved);
  assert.deepEqual(saved.messages.at(-1)?.receipt, newerReceipt);
  assert.equal(useRequestReceipts.getState().receipts.length, 2, 'restore does not duplicate session receipts');
});
