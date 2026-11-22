/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { documentContent, parseDocumentFile, portableGenerationReceipt } from '@/lib/document/persistence';
import { prepareDocument } from '@/lib/document/prepare-document';
import { exportPreparedDocument, documentPdfWarnings } from '@/lib/document/export-prepared-document';
import { captureAnalysisStamp, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { sanitizeFilename } from '@/lib/export/download';
import { nativeDocumentSummary } from '@/lib/document/native-inspection';
import type { DocumentSpec } from '@/lib/document/types';
import { boundedPage, pageInput, pageOutputProperties, type PageRequest } from './result-limit';
import { viewerOperation, emptySchema } from './contract';
import { matchesJsonSnapshot, metadata, idSchema, jsonSchema, artifactSchema, removedSchema, checkpoint } from './analytics-common';
import { internal, invalidInput, stale, parseJsonInput, decodedInput } from './refusals';

// Full-document replacement is intentionally bounded. Media-heavy documents
// can be edited incrementally and exported through the artifact channel.
const documentJson = { ...jsonSchema.properties.content_json, maxLength: 2_000_000 };
const documentImportSchema = { ...jsonSchema, properties: { content_json: documentJson } };
/** Non-throwing: after an await, a deleted document reads as stale, not as an unknown id. */
const findDocument = (id: string) => useViewerStore.getState().documents.find(row => row.id === id);
function documentById(id: string) {
  const value = findDocument(id);
  if (!value) throw invalidInput('unknown-target', 'Unknown native document. Initialize the library first.');
  return structuredClone(value);
}
// Store edits replace document records. Cache each successful digest by identity so later pages do not rehash media.
const documentSummaries = new WeakMap<DocumentSpec, Awaited<ReturnType<typeof nativeDocumentSummary>>>();
async function summaryOf(document: DocumentSpec) {
  const cached = documentSummaries.get(document);
  if (cached) return cached;
  const summary = await nativeDocumentSummary(document);
  documentSummaries.set(document, summary);
  return summary;
}
const savedSchema = { type: 'object', properties: { id: { type: 'string' }, blocks: { type: 'integer' } }, required: ['id', 'blocks'], additionalProperties: false };
export const analyticsDocumentOperations = [
  viewerOperation<PageRequest>(metadata('document.library', 'document', 'Read a bounded page of document summaries and compact SHA-256 revisions; embedded media, blocks and AI evidence stay local. Defaults offset=0, limit=20. Pass next_offset and page_revision to continue. Inspect paged block metadata or export native JSON for complete content.', ['read'], {
    type: 'object', properties: { documents: { type: 'array' }, total: { type: 'integer' }, ...pageOutputProperties, storage: { type: 'object' }, activeId: { type: ['string', 'null'] } }, required: ['documents', 'total', 'next_offset', 'page_revision', 'storage', 'activeId'], additionalProperties: false,
  }), { ...pageInput, properties: { ...pageInput.properties, limit: { type: 'integer', minimum: 1, maximum: 50, nullable: true } } } satisfies JSONSchemaType<PageRequest>, async (i, c) => {
    const { documents, documentsStorage, activeDocumentId: activeId } = useViewerStore.getState();
    const rows = [];
    for (const document of documents) {
      const summary = await summaryOf(document);
      checkpoint(c);
      const now = useViewerStore.getState();
      if (now.documents !== documents || now.documentsStorage !== documentsStorage) throw stale('Document library changed during inspection. Retry discovery.');
      rows.push({ document: summary, storage: { [document.id]: documentsStorage.items[document.id] ?? null } });
    }
    const storage = { phase: documentsStorage.phase, recovered: documentsStorage.recovered };
    const { items, offset: _offset, ...page } = boundedPage(rows, { ...i, limit: i.limit ?? 20 }, { activeId, storage });
    return { ...page, documents: items.map(row => row.document), activeId,
      storage: { ...storage, items: Object.fromEntries(items.flatMap(row => Object.entries(row.storage))) } };
  }),
  viewerOperation(metadata('document.initialize', 'document', 'Await the native IndexedDB document library initialization; no panel mount is required.', ['configuration'], { type: 'object', properties: { initialized: { type: 'boolean' }, count: { type: 'integer' } }, required: ['initialized', 'count'], additionalProperties: false }), emptySchema, async (_, c) => {
    checkpoint(c); const initialized = await c.commitAsync(() => useViewerStore.getState().initializeDocuments()); checkpoint(c);
    if (!initialized) throw internal('Native document library initialization failed. Inspect document.library storage diagnostics.');
    return { initialized, count: useViewerStore.getState().documents.length };
  }),
  viewerOperation<{ content_json: string }>(metadata('document.import', 'document', 'Import a complete native document JSON with independently remapped document/block IDs, validated bindings and native persistence. For files above the bridge input limit use the viewer file importer.', ['configuration'], savedSchema), documentImportSchema, async (i, c) => {
    const document = decodedInput('content_json', () => parseDocumentFile(i.content_json), { json: true }); checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().upsertDocument(document))) throw internal(`Native document persistence failed for ${document.id}. Check document.library for staged content and save status.`);
    return { id: document.id, blocks: document.blocks.length };
  }),
  viewerOperation<{ id: string; expected_json: string; content_json: string }>(metadata('document.replace', 'document', 'Replace structured blocks/page settings through the native validator and persistence. expected_json must equal the current document; ID changes are refused.', ['configuration'], savedSchema), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: documentJson, content_json: documentJson }, required: ['id', 'expected_json', 'content_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string; content_json: string }>, async (i, c) => {
    const before = documentById(i.id);
    if (!matchesJsonSnapshot(before, i.expected_json)) throw stale('Document changed since inspection.');
    const document = documentContent.decode(parseJsonInput(i.content_json, 'content_json'));
    if (!document || document.id !== i.id) throw invalidInput('invalid-value', 'Invalid document or changed document ID.');
    if (document.blocks.some(block => block.id.length > idSchema.properties.id.maxLength)) {
      throw invalidInput('limit', 'Replacement block IDs must fit the native edit address limit.');
    }
    checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().upsertDocument(document))) throw internal('Native document persistence failed.');
    return { id: document.id, blocks: document.blocks.length };
  }),
  viewerOperation<{ id: string }>(metadata('document.delete', 'document', 'Await native deletion of one saved document.', ['configuration'], removedSchema), idSchema, async (i, c) => {
    documentById(i.id); checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().deleteDocument(i.id))) throw internal('Native document deletion failed.');
    return { removed: i.id };
  }),
  viewerOperation<{ id: string; format: 'json' | 'pdf' }>(metadata('document.export', 'document', 'Resolve all native document charts/list tables, await real PDF rendering or JSON serialization, and return a retrievable artifact with warnings and page count.', ['read', 'artifact'], {
    type: 'object', properties: { artifact: artifactSchema, pages: { type: 'integer', minimum: 0 }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['artifact', 'pages', 'warnings'], additionalProperties: false,
  }), {
    type: 'object', properties: { id: idSchema.properties.id, format: { type: 'string', enum: ['json', 'pdf'] } }, required: ['id', 'format'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; format: 'json' | 'pdf' }>, async (i, c) => {
    const document = documentById(i.id); checkpoint(c);
    const stem = sanitizeFilename(document.name, { fallback: 'document' });
    if (i.format === 'json') {
      const portable = portableGenerationReceipt(document);
      if (!portable) throw invalidInput('invalid-value', 'Invalid document generation receipt.');
      return { artifact: await c.artifacts.create({ filename: `${stem}.ifclite-document.json`, mimeType: 'application/json', data: JSON.stringify(portable, null, 2) }), pages: 0, warnings: [] };
    }
    const stamp = captureAnalysisStamp(true);
    const input = await prepareDocument(document, useViewerStore.getState(), { signal: c.signal }); checkpoint(c);
    const result = await exportPreparedDocument(input, { signal: c.signal }); checkpoint(c);
    if (isAnalysisStale(stamp, useViewerStore.getState())) throw stale('Document source models changed during rendering; discarded artifact.');
    if (JSON.stringify(findDocument(i.id)) !== JSON.stringify(document)) throw stale('Document changed during rendering; discarded artifact.');
    const artifact = await c.artifacts.create({ filename: `${stem}.pdf`, mimeType: 'application/pdf', data: result.blob });
    return { artifact, pages: result.pages, warnings: documentPdfWarnings(result) };
  }),
];
