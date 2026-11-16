/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import type { DocumentSpec } from '@/lib/document/types';
import { nativeDocumentRevision, patchNativeDocumentBlock, patchNativeDocumentPage, copyNativeDocumentBlock, moveNativeDocumentBlocks, replaceNativeDocumentBlocks, addNativeDocumentBlock } from '@/lib/document/native-edit';
import { nativeDocumentSummary, nativeBlockMetadata, nativeDocumentPageMetadata } from '@/lib/document/native-inspection';
import { viewerOperation, type ViewerOperationContext } from './contract';
import { metadata, checkpoint, idSchema } from './analytics-common';
const revisionSchema = { type: 'string' as const, pattern: '^sha256:[a-f0-9]{64}$' };
const json = { type: 'string' as const, minLength: 2, maxLength: 100000 };
const written = { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'string' }, block_id: { type: ['string', 'null'] }, blocks: { type: 'integer' } }, required: ['id', 'revision', 'block_id', 'blocks'], additionalProperties: false };
function current(id: string) { const doc = useViewerStore.getState().documents.find(row => row.id === id); if (!doc) throw new Error('Unknown native document.'); return doc; }
async function admitted(id: string, expected: string, c: ViewerOperationContext) {
  const before = current(id); if (await nativeDocumentRevision(before) !== expected || current(id) !== before) throw new Error('Document changed since inspection.'); checkpoint(c); return before;
}
async function persist(before: DocumentSpec, next: DocumentSpec, blockId: string | null, c: ViewerOperationContext) {
  checkpoint(c);
  if (!await c.commitAsync(() => { if (current(before.id) !== before) throw new Error('Document changed before native persistence admission.'); return useViewerStore.getState().upsertDocument(next); })) throw new Error('Native document persistence failed; inspect the library save status.');
  const live = current(before.id); return { id: live.id, revision: await nativeDocumentRevision(live), block_id: blockId, blocks: live.blocks.length };
}
export const documentNativeEditOperations = [
  viewerOperation<{ id: string; offset: number; limit: number }>(metadata('document.inspect', 'document', 'Inspect one document revision/page metadata and a bounded page of block metadata. Large media bodies, evidence, generated text and long text are omitted/truncated; full native JSON remains available through document.export.', ['read'], { type: 'object', properties: { document: { type: 'object' }, page_metadata_json: { type: 'string' }, blocks: { type: 'array' }, total_blocks: { type: 'integer' }, next_offset: { type: ['integer', 'null'] } }, required: ['document', 'page_metadata_json', 'blocks', 'total_blocks', 'next_offset'], additionalProperties: false }), {
    type: 'object', properties: { id: idSchema.properties.id, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['id', 'offset', 'limit'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; offset: number; limit: number }>, async (i, c) => {
    const doc = current(i.id); const summary = await nativeDocumentSummary(doc); checkpoint(c); if (current(i.id) !== doc) throw new Error('Document changed during inspection.');
    const blocks = doc.blocks.slice(i.offset, i.offset + i.limit).map((block, n) => nativeBlockMetadata(block, i.offset + n));
    return { document: summary, page_metadata_json: nativeDocumentPageMetadata(doc), blocks, total_blocks: doc.blocks.length, next_offset: i.offset + blocks.length < doc.blocks.length ? i.offset + blocks.length : null };
  }),
  viewerOperation<{ id: string; expected_revision: string; block_id: string; patch_json: string }>(metadata('document.editBlock', 'document', 'Patch only existing native editable fields on one block with a compact full-document SHA-256 guard. Unedited media and AI provenance remain intact; editing generated text keeps its authored-versus-generated distinction. null clears an optional native field. Native block-kind allowlists and full document validation run before native CAS persistence.', ['configuration'], written), {
    type: 'object', properties: { id: idSchema.properties.id, expected_revision: revisionSchema, block_id: idSchema.properties.id, patch_json: json }, required: ['id', 'expected_revision', 'block_id', 'patch_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_revision: string; block_id: string; patch_json: string }>, async (i, c) => { const before = await admitted(i.id, i.expected_revision, c); return persist(before, patchNativeDocumentBlock(before, i.block_id, JSON.parse(i.patch_json)), i.block_id, c); }),
  viewerOperation<{ id: string; expected_revision: string; patch_json: string }>(metadata('document.editPage', 'document', 'Patch native document name/page size/orientation and heading/footer typography/text/logo height/date/page-number settings with a compact revision guard. Existing embedded logos survive omitted media fields; null clears optional bands/overrides. Uses the same native transform and validator as DocumentPanel.', ['configuration'], written), {
    type: 'object', properties: { id: idSchema.properties.id, expected_revision: revisionSchema, patch_json: json }, required: ['id', 'expected_revision', 'patch_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_revision: string; patch_json: string }>, async (i, c) => { const before = await admitted(i.id, i.expected_revision, c); return persist(before, patchNativeDocumentPage(before, JSON.parse(i.patch_json)), null, c); }),
  viewerOperation<{ id: string; expected_revision: string; action: 'copy' | 'remove' | 'move'; block_ids: string[]; before_id: string }>(metadata('document.blocks', 'document', 'Use native document block copy/remove/reorder transforms under a compact revision guard. Copy receives native fresh IDs and detaches AI provenance exactly as the panel; move preserves IDs, media, AI evidence and ordering of the selected group. Empty before_id means append.', ['configuration'], written), {
    type: 'object', properties: { id: idSchema.properties.id, expected_revision: revisionSchema, action: { type: 'string', enum: ['copy', 'remove', 'move'] }, block_ids: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: idSchema.properties.id }, before_id: { type: 'string', maxLength: 200 } }, required: ['id', 'expected_revision', 'action', 'block_ids', 'before_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_revision: string; action: 'copy' | 'remove' | 'move'; block_ids: string[]; before_id: string }>, async (i, c) => {
    const before = await admitted(i.id, i.expected_revision, c); if (i.block_ids.some(id => !before.blocks.some(block => block.id === id)) || i.before_id && !before.blocks.some(block => block.id === i.before_id)) throw new Error('Unknown native block or reorder target.');
    if (i.action === 'copy') { if (i.block_ids.length !== 1) throw new Error('The native copy control copies one block.'); const copy = copyNativeDocumentBlock(before, i.block_ids[0]); return persist(before, copy.document, copy.id, c); }
    return persist(before, i.action === 'move' ? moveNativeDocumentBlocks(before, new Set(i.block_ids), i.before_id || null) : replaceNativeDocumentBlocks(before, before.blocks.filter(block => !i.block_ids.includes(block.id))), null, c);
  }),
  viewerOperation<{ id: string; expected_revision: string; block_json: string; before_id: string }>(metadata('document.addBlock', 'document', 'Insert one small native structured block with a fresh block ID, full native validation and a compact revision guard. Empty before_id appends; large existing media need not be resent. Image file selection/large media insertion remains the existing native input workflow.', ['configuration'], written), {
    type: 'object', properties: { id: idSchema.properties.id, expected_revision: revisionSchema, block_json: json, before_id: { type: 'string', maxLength: 200 } }, required: ['id', 'expected_revision', 'block_json', 'before_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_revision: string; block_json: string; before_id: string }>, async (i, c) => { const before = await admitted(i.id, i.expected_revision, c); const added = addNativeDocumentBlock(before, JSON.parse(i.block_json), i.before_id || null); return persist(before, added.document, added.id, c); }),
];
