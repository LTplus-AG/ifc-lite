/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { createMainViewerToolHost } from '../main-viewer-host';
import { operationArtifacts } from './artifacts';
import type { ViewerOperationContext } from './contract';
import { analyticsDocumentOperations } from './analytics-document';
import { documentNativeEditOperations } from './document-native-edit';
import { blankDocument } from '@/lib/document/presets';
import { loadDocuments } from '@/lib/document/persistence';
import { aiBlockOrigin } from '@/lib/document/ai-report-types';
import { resetFeaturesForTest } from '@/lib/features';
import { largePng } from '@/test/large-native-png';
it('#10525 pages large native documents and edits text without resending or losing media/provenance; stale edits fail', async () => {
  resetFeaturesForTest(); const document = blankDocument(); const dataUrl = largePng(); assert.ok(dataUrl.length > 1024 * 1024);
  document.blocks = [{ kind: 'text', id: 'narrative', style: 'body', text: 'Original narrative', aiProvenance: { origin: 'ai', slot: 'narrative:0', generated: 'Original narrative' } }, { kind: 'image', id: 'image', dataUrl, height: 60, align: 'left' }];
  document.pageHeading = { text: 'Heading', logo: { dataUrl, height: 32 } };
  document.aiReport = { version: 1, language: 'en', model: 'native-provider', conversationId: 'retained-conversation', revision: 1, evidence: { source: 'clash', capturedAt: '2026-11-16T00:00:00Z', payload: '{"evidence":{"summary":null,"rows":[]}}', totalRows: 0, includedRows: 0, projectionTruncated: false }, citedRows: {}, claims: [], narrative: 'Original narrative', slots: ['narrative:0'] };
  assert.ok(await useViewerStore.getState().upsertDocument(document));
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T,>(write: () => T): T => write();
  const context: ViewerOperationContext = { host, commit, commitAsync: async <T,>(write: () => Promise<T>) => write(), ownGeometry: async work => work(), retain: () => {}, artifacts: operationArtifacts(host, commit), canEdit: () => true };
  const run = async <T,>(id: string, input: unknown): Promise<T> => { const entry = [...analyticsDocumentOperations, ...documentNativeEditOperations].find(row => row.id === id); assert.ok(entry); assert.equal(entry.needs, 'viewer'); const result = await entry.execute(input, context); entry.validateResult(JSON.parse(JSON.stringify(result))); return result as T; };
  assert.ok(await useViewerStore.getState().upsertDocument(blankDocument()));
  const library = await run<{ documents: { id: string; revision: string }[]; next_offset: number; page_revision: string }>('document.library', { offset: 0, limit: 1 });
  const libraryCursor = { offset: library.next_offset, page_revision: library.page_revision, limit: 1 };
  assert.equal(libraryCursor.offset, 1); assert.ok(libraryCursor.page_revision);
  const continuation = await run<typeof library>('document.library', libraryCursor);
  assert.notEqual(continuation.documents[0].id, library.documents[0].id);
  assert.ok(JSON.stringify(library).length < 32000); assert.doesNotMatch(JSON.stringify(library), /data:image/);
  const inspected = await run<{ document: { revision: string }; blocks: unknown[]; next_offset: number | null; page_revision: string }>('document.inspect', { id: document.id, offset: 0, limit: 1 });
  assert.equal(inspected.next_offset, 1); assert.equal(inspected.blocks.length, 1); assert.ok(JSON.stringify(inspected).length < 20000); assert.doesNotMatch(JSON.stringify(inspected), /base64/);
  const blockCursor = { id: document.id, offset: inspected.next_offset, page_revision: inspected.page_revision, limit: 1 };
  const media = await run<{ blocks: unknown[] }>('document.inspect', blockCursor);
  assert.equal(media.blocks.length, 1);
  assert.match(JSON.stringify(media.blocks), /"kind":"image"/);
  assert.doesNotMatch(JSON.stringify(media), /base64|data:image/);
  const input = { id: document.id, expected_revision: inspected.document.revision, block_id: 'narrative', patch_json: '{"text":"Small native text edit"}' };
  assert.ok(JSON.stringify(input).length < 1000); const saved = await run<{ revision: string }>('document.editBlock', input); assert.notEqual(saved.revision, inspected.document.revision);
  await assert.rejects(run('document.editBlock', input), /changed since inspection/);
  // #10877: an edit changes the exact block metadata population behind the cursor.
  await assert.rejects(run('document.inspect', blockCursor), { code: 'STATE_CHANGED' });
  const persisted = (await loadDocuments()).find(row => row.id === document.id); assert.ok(persisted);
  assert.equal(persisted.blocks[0].kind === 'text' && persisted.blocks[0].text, 'Small native text edit');
  assert.equal(persisted.blocks[0].kind === 'text' && aiBlockOrigin(persisted.blocks[0]), 'human-edited');
  assert.deepEqual(persisted.blocks[0].kind === 'text' && persisted.blocks[0].aiProvenance,
    document.blocks[0].kind === 'text' && document.blocks[0].aiProvenance);
  assert.deepEqual(persisted.aiReport, document.aiReport); assert.deepEqual(persisted.blocks[1], document.blocks[1]); assert.deepEqual(persisted.pageHeading, document.pageHeading);
  for (const [name, invalid] of [
    ['document.editPage', { patch_json: '[]' }],
    ['document.editBlock', { block_id: 'narrative', patch_json: '{"unexpected":true}' }],
    ['document.addBlock', { block_json: '{"kind":"unknown"}', before_id: '' }],
  ] as const) {
    await assert.rejects(run(name, { id: document.id, expected_revision: saved.revision, ...invalid }), {
      code: 'INVALID_INPUT', details: { reason: 'invalid-value' },
    });
  }
  await run('document.editPage', { id: document.id, expected_revision: saved.revision, patch_json: '{"page":{"orientation":"landscape"},"pageHeading":{"text":"Edited heading"}}' });
  const pageSaved = (await loadDocuments()).find(row => row.id === document.id); assert.equal(pageSaved?.page.orientation, 'landscape'); assert.equal(pageSaved?.pageHeading?.logo?.dataUrl, dataUrl);
  assert.ok(await useViewerStore.getState().deleteDocument(library.documents[0].id));
  await assert.rejects(run('document.library', libraryCursor), { code: 'STATE_CHANGED' });
});
