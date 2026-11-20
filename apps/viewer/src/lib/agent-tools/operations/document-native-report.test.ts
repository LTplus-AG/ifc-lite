/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { createMainViewerToolHost } from '../main-viewer-host';
import { useViewerStore } from '@/store';
import { nativeDocumentRevision } from '@/lib/document/native-edit';
import { largePng } from '@/test/large-native-png';
import { clashDiscussion, seedClashResult, typedReport } from '@/test/ai-report-fixture';
import { useAssistant } from '@/lib/assistant/conversation';
import { prepareReportDraft } from '@/lib/assistant/report-draft';
import { readContentRows, writeContent } from '@/lib/storage/content-database';
import type { DocumentSpec, TextBlock } from '@/lib/document/types';
import type { ViewerOperationContext } from './contract';
import { operationArtifacts } from './artifacts';
import { documentNativeReportOperations } from './document-native-report';
import { documentNativeReportDraftOperations } from './document-native-report-draft';
const operations = [...documentNativeReportOperations, ...documentNativeReportDraftOperations];
let context: ViewerOperationContext, allowed = true;
const persisted: boolean[] = [];
function nativeHost() { return createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) })); }
const checkpoint = () => { if (!allowed) throw new Error('Native report grant revoked'); };
async function invoke<T>(id: string, input: unknown, host = context): Promise<T> { const operation = operations.find(operation => operation.id === id); assert.ok(operation); operation.validate(input); const result = await operation.execute(input, host); operation.validateResult(result); return result as T; }
function discussion() {
  clashDiscussion(typedReport('Coordination evidence [E1].', [{ text: 'The estimated overlap is 20 mm.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }]));
}
beforeEach(async () => {
  allowed = true; persisted.length = 0;
  const host = nativeHost(), commit = <T>(write: () => T) => { checkpoint(); return write(); };
  context = { host, checkpoint, commit, commitAsync: async (write, didCommit) => { checkpoint(); const result = await write(); persisted.push(didCommit ? didCommit(result) : result !== false); return result; }, ownGeometry: async work => work(), artifacts: operationArtifacts(host, commit) };
  await useViewerStore.getState().initializeDocuments();
});
async function savedHumanReport() {
  discussion(); const draft = prepareReportDraft('Native refresh fixture'), block = draft.document.blocks.find((block): block is TextBlock => block.kind === 'text' && block.aiProvenance?.slot === 'claim-facts:C1'); assert.ok(block);
  const document = { ...draft.document, blocks: draft.document.blocks.map(entry => entry.id === block.id ? { ...block, text: 'Human meeting record: verify on site.' } : entry) };
  assert.equal(await useViewerStore.getState().upsertDocument(document), true);
  seedClashResult([-0.04, -0.035, -0.05]); return { document, blockId: block.id };
}
it('native report refresh retains human text, rejects non-conflict IDs and persists real generated provenance (#6918)', async () => {
  const { document, blockId } = await savedHumanReport();
  const plan = await invoke<{ token: string; conflicts: Array<{ blockId: string }> }>('document.prepareReportRefresh', { document_id: document.id, expected_revision: await nativeDocumentRevision(document) });
  assert.ok(plan.conflicts.some(conflict => conflict.blockId === blockId));
  await assert.rejects(invoke('document.applyReportRefresh', { token: plan.token, replace_block_ids: ['forged-human-block'] }), /conflict IDs/);
  const result = await invoke<{ saved: boolean }>('document.applyReportRefresh', { token: plan.token, replace_block_ids: [] }); assert.equal(result.saved, true);
  const saved = (await readContentRows('document')).find(row => row.id === document.id)?.payload as DocumentSpec;
  assert.equal(saved.aiReport?.revision, 2); assert.equal(saved.blocks.find((block): block is TextBlock => block.id === blockId && block.kind === 'text')?.text, 'Human meeting record: verify on site.');
  assert.equal(saved.aiReport?.claims[0].status, 'contradicted');
  await assert.rejects(invoke('document.applyReportRefresh', { token: plan.token, replace_block_ids: [] }), /discarded/);
});
it('native refresh tokens reject another host, changed evidence and changed documents before persistence (#6918)', async () => {
  const { document } = await savedHumanReport();
  const input = { document_id: document.id, expected_revision: await nativeDocumentRevision(document) };
  const foreign = await invoke<{ token: string }>('document.prepareReportRefresh', input);
  await assert.rejects(invoke('document.applyReportRefresh', { token: foreign.token, replace_block_ids: [] }, { ...context, host: nativeHost() }), /this host/);
  seedClashResult([-0.06]); await assert.rejects(invoke('document.applyReportRefresh', { token: foreign.token, replace_block_ids: [] }), /evidence changed/);
  const fresh = await invoke<{ token: string }>('document.prepareReportRefresh', input);
  assert.equal(await useViewerStore.getState().upsertDocument({ ...document, name: 'A human changed this report' }), true);
  await assert.rejects(invoke('document.applyReportRefresh', { token: fresh.token, replace_block_ids: [] }), /document changed/);
});
it('native refresh exposes a real IndexedDB CAS refusal without claiming a durable commit (#6918)', async () => {
  const { document } = await savedHumanReport(), plan = await invoke<{ token: string }>('document.prepareReportRefresh', { document_id: document.id, expected_revision: await nativeDocumentRevision(document) });
  const previous = (await readContentRows('document')).find(row => row.id === document.id); assert.ok(previous);
  const external = { ...document, name: 'Concurrent other-tab report' };
  assert.equal((await writeContent('document', document.id, external, previous.revision)).ok, true);
  const result = await invoke<{ saved: boolean; storage: { items: Record<string, string> } }>('document.applyReportRefresh', { token: plan.token, replace_block_ids: [] });
  assert.equal(result.saved, false); assert.equal(persisted.at(-1), false); assert.equal(result.storage.items[document.id], 'conflict');
  assert.deepEqual((await readContentRows('document')).find(row => row.id === document.id)?.payload, external);
});
it('Assistant saves only the exact canonical checked report and preserves its actual provider/evidence provenance (#6830)', async () => {
  discussion(); const state = useAssistant.getState();
  const prepared = await invoke<{ token: string; document_id: string; document_json: string }>('assistant.prepareReportDraft', { name: 'Checked native report', language: 'en', expected_evidence_id: state.snapshot!.id, expected_answer: state.messages.at(-1)!.content });
  await assert.rejects(invoke('assistant.saveReportDraft', { token: prepared.token, reviewed_document_json: prepared.document_json + ' ' }), /changed native checked/);
  allowed = false; await assert.rejects(invoke('assistant.saveReportDraft', { token: prepared.token, reviewed_document_json: prepared.document_json }), /grant revoked/); allowed = true;
  const result = await invoke<{ saved: boolean }>('assistant.saveReportDraft', { token: prepared.token, reviewed_document_json: prepared.document_json }); assert.equal(result.saved, true);
  const saved = (await readContentRows('document')).find(row => row.id === prepared.document_id)?.payload as DocumentSpec;
  assert.equal(saved.aiReport?.model, 'actual-provider'); assert.equal(saved.aiReport?.claims[0].status, 'supported'); assert.ok(saved.aiReport?.citedRows.E1);
});
it('native refresh replaces only an explicitly selected real human-block conflict (#6918)', async () => {
  const { document, blockId } = await savedHumanReport();
  const plan = await invoke<{ token: string }>('document.prepareReportRefresh', { document_id: document.id, expected_revision: await nativeDocumentRevision(document) });
  await invoke('document.applyReportRefresh', { token: plan.token, replace_block_ids: [blockId] });
  const saved = (await readContentRows('document')).find(row => row.id === document.id)?.payload as DocumentSpec;
  const replaced = saved.blocks.find((block): block is TextBlock => block.id === blockId && block.kind === 'text'); assert.ok(replaced);
  assert.doesNotMatch(replaced.text, /Human meeting/); assert.match(replaced.text, /-0\.04/);
});
it('checked native report save refuses contradicted claims until canonical reviewer removal (#6830)', async () => {
  clashDiscussion(typedReport('Coordination evidence [E1].', [{ text: 'The estimated overlap is 999 mm.', facts: [{ citation: 'E1', field: 'distance', value: -999, unit: 'mm' }] }]));
  const state = useAssistant.getState(), prepared = await invoke<{ token: string; document_json: string; contradicted_claim_ids: string[] }>('assistant.prepareReportDraft', { name: 'Contradicted report', language: 'en', expected_evidence_id: state.snapshot!.id, expected_answer: state.messages.at(-1)!.content });
  assert.deepEqual(prepared.contradicted_claim_ids, ['C1']);
  await assert.rejects(invoke('assistant.saveReportDraft', { token: prepared.token, reviewed_document_json: prepared.document_json }), /contradicted/);
  const revised = await invoke<{ document_json: string; contradicted_claim_ids: string[] }>('assistant.reviseReportDraftClaim', { token: prepared.token, expected_document_json: prepared.document_json, claim_id: 'C1', action: 'remove', text: '' });
  assert.deepEqual(revised.contradicted_claim_ids, []);
  const saved = await invoke<{ saved: boolean }>('assistant.saveReportDraft', { token: prepared.token, reviewed_document_json: revised.document_json }); assert.equal(saved.saved, true);
});

it('refreshes an image-heavy native report using compact revision guards and preserves its media', async () => {
  const { document } = await savedHumanReport(), dataUrl = largePng();
  document.blocks.push({ kind: 'image', id: 'human-image', dataUrl, height: 60, align: 'left' });
  assert.ok(JSON.stringify(document).length > 1024 * 1024);
  assert.equal(await useViewerStore.getState().upsertDocument(document), true);
  const input = { document_id: document.id, expected_revision: await nativeDocumentRevision(document) };
  assert.ok(JSON.stringify(input).length < 1024);
  const plan = await invoke<{ token: string }>('document.prepareReportRefresh', input);
  const result = await invoke<{ saved: boolean; revision: string }>('document.applyReportRefresh', { token: plan.token, replace_block_ids: [] });
  assert.equal(result.saved, true); assert.ok(JSON.stringify(result).length < 10000);
  const saved = (await readContentRows('document')).find(row => row.id === document.id)?.payload as DocumentSpec;
  const image = saved.blocks.find(block => block.id === 'human-image'); assert.ok(image?.kind === 'image'); assert.equal(image.dataUrl, dataUrl);
  assert.equal(result.revision, await nativeDocumentRevision(saved));
});
