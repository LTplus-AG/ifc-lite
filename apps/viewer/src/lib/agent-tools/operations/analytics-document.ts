/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { documentContent, parseDocumentFile } from '@/lib/document/persistence';
import { prepareDocument } from '@/lib/document/prepare-document';
import { exportPreparedDocument, documentPdfWarnings } from '@/lib/document/export-prepared-document';
import { captureAnalysisStamp, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { sanitizeFilename } from '@/lib/export/download';
import { viewerOperation, emptySchema } from './contract';
import { metadata, idSchema, jsonSchema, artifactSchema, removedSchema, checkpoint } from './analytics-common';

function documentById(id: string) {
  const value = useViewerStore.getState().documents.find(row => row.id === id);
  if (!value) throw new Error('Unknown native document. Initialize the library first.');
  return structuredClone(value);
}
const savedSchema = { type: 'object', properties: { id: { type: 'string' }, blocks: { type: 'integer' } }, required: ['id', 'blocks'], additionalProperties: false };
export const analyticsDocumentOperations = [
  viewerOperation(metadata('document.library', 'document', 'Read current structured documents and native persistence status.', ['read'], {
    type: 'object', properties: { documents: { type: 'array' }, storage: { type: 'object' }, activeId: { type: ['string', 'null'] } }, required: ['documents', 'storage', 'activeId'], additionalProperties: false,
  }), emptySchema, () => { const s = useViewerStore.getState(); return { documents: s.documents, storage: s.documentsStorage, activeId: s.activeDocumentId }; }),
  viewerOperation(metadata('document.initialize', 'document', 'Await the native IndexedDB document library initialization; no panel mount is required.', ['configuration'], { type: 'object', properties: { initialized: { type: 'boolean' }, count: { type: 'integer' } }, required: ['initialized', 'count'], additionalProperties: false }), emptySchema, async (_, c) => {
    checkpoint(c); const initialized = await c.commitAsync(() => useViewerStore.getState().initializeDocuments()); checkpoint(c);
    if (!initialized) throw new Error('Native document library initialization failed. Inspect document.library storage diagnostics.');
    return { initialized, count: useViewerStore.getState().documents.length };
  }),
  viewerOperation<{ content_json: string }>(metadata('document.import', 'document', 'Import a complete native document JSON with independently remapped document/block IDs, validated bindings and native persistence.', ['configuration'], savedSchema), jsonSchema, async (i, c) => {
    const document = parseDocumentFile(i.content_json); checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().upsertDocument(document))) throw new Error('Native document persistence failed.');
    return { id: document.id, blocks: document.blocks.length };
  }),
  viewerOperation<{ id: string; expected_json: string; content_json: string }>(metadata('document.replace', 'document', 'Replace structured blocks/page settings through the native validator and persistence. expected_json must equal the current document; ID changes are refused.', ['configuration'], savedSchema), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: jsonSchema.properties.content_json, content_json: jsonSchema.properties.content_json }, required: ['id', 'expected_json', 'content_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string; content_json: string }>, async (i, c) => {
    const before = documentById(i.id);
    if (JSON.stringify(before) !== JSON.stringify(JSON.parse(i.expected_json))) throw new Error('Document changed since inspection.');
    const document = documentContent.decode(JSON.parse(i.content_json));
    if (!document || document.id !== i.id) throw new Error('Invalid document or changed document ID.');
    checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().upsertDocument(document))) throw new Error('Native document persistence failed.');
    return { id: document.id, blocks: document.blocks.length };
  }),
  viewerOperation<{ id: string }>(metadata('document.delete', 'document', 'Await native deletion of one saved document.', ['configuration'], removedSchema), idSchema, async (i, c) => {
    documentById(i.id); checkpoint(c);
    if (!await c.commitAsync(() => useViewerStore.getState().deleteDocument(i.id))) throw new Error('Native document deletion failed.');
    return { removed: i.id };
  }),
  viewerOperation<{ id: string; format: 'json' | 'pdf' }>(metadata('document.export', 'document', 'Resolve all native document charts/list tables, await real PDF rendering or JSON serialization, and return a retrievable artifact with warnings and page count.', ['read', 'artifact'], {
    type: 'object', properties: { artifact: artifactSchema, pages: { type: 'integer', minimum: 0 }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['artifact', 'pages', 'warnings'], additionalProperties: false,
  }), {
    type: 'object', properties: { id: idSchema.properties.id, format: { type: 'string', enum: ['json', 'pdf'] } }, required: ['id', 'format'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; format: 'json' | 'pdf' }>, async (i, c) => {
    const document = documentById(i.id); checkpoint(c);
    const stem = sanitizeFilename(document.name, { fallback: 'document' });
    if (i.format === 'json') return { artifact: await c.artifacts.create({ filename: `${stem}.ifclite-document.json`, mimeType: 'application/json', data: JSON.stringify(document, null, 2) }), pages: 0, warnings: [] };
    const stamp = captureAnalysisStamp(true);
    const input = await prepareDocument(document, useViewerStore.getState(), { signal: c.signal }); checkpoint(c);
    const result = await exportPreparedDocument(input, { signal: c.signal }); checkpoint(c);
    if (isAnalysisStale(stamp, useViewerStore.getState())) throw new Error('Document source models changed during rendering; discarded artifact.');
    if (JSON.stringify(documentById(i.id)) !== JSON.stringify(document)) throw new Error('Document changed during rendering; discarded artifact.');
    const artifact = await c.artifacts.create({ filename: `${stem}.pdf`, mimeType: 'application/pdf', data: result.blob });
    return { artifact, pages: result.pages, warnings: documentPdfWarnings(result) };
  }),
];
