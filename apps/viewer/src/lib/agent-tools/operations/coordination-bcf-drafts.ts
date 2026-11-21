/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { useBcfDraftLibrary, bcfDraftLibrary, saveDraftBatch } from '@/lib/bcf-drafts/draft-library';
import { coordination, idSchema, textSchema } from './coordination-common';
import { emptySchema, type ViewerOperationContext } from './contract';
import { decodedInput, invalidInput, stale } from './refusals';
export function guardedDraftBatch(id: string, expected: string) {
  const found = useBcfDraftLibrary.getState().entries.find(batch => batch.id === id);
  if (!found) throw invalidInput('unknown-target', 'Unknown draft batch.');
  if (found.modifiedAt !== expected) throw stale('Draft batch changed or no longer exists.');
  return found;
}
export async function saveGuardedDraftBatch(before: DraftBatch, next: DraftBatch, c: ViewerOperationContext) {
  c.checkpoint?.(); return c.commitAsync(async () => {
    if (useBcfDraftLibrary.getState().entries.find(batch => batch.id === before.id) !== before) throw stale('Draft batch changed during preparation.');
    return { batch: next, saved: await saveDraftBatch(next) };
  }, result => result.saved);
}
export const coordinationBcfDraftOperations = [
  coordination('bcf.drafts', 'Initialize and inspect native draft batches, topic/member identities and save status.', ['read'], emptySchema, async () => {
    await bcfDraftLibrary.initialize(); const { entries, status } = useBcfDraftLibrary.getState(); return { batches: entries, storage: status };
  }),
  coordination<{ batch_id: string; expected_modified_at: string; topic_guid: string; title: string; description: string; topic_type: string; status: string; priority: string; labels: string[]; assigned_to: string }>('bcf.editDraftTopic', 'Edit an exact native draft topic through the native draft codec/reducer and await durable save.', ['configuration'], {
    type: 'object', properties: { batch_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_modified_at: { type: 'string', minLength: 1, maxLength: 100 }, topic_guid: { type: 'string', minLength: 1, maxLength: 200 }, title: { type: 'string', minLength: 1, maxLength: 500 }, description: { type: 'string', maxLength: 10000 }, topic_type: { type: 'string', maxLength: 200 }, status: { type: 'string', maxLength: 200 }, priority: { type: 'string', maxLength: 200 }, labels: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } }, assigned_to: { type: 'string', maxLength: 500 } }, required: ['batch_id', 'expected_modified_at', 'topic_guid', 'title', 'description', 'topic_type', 'status', 'priority', 'labels', 'assigned_to'], additionalProperties: false,
  }, async (i, c) => {
    const { editDraftTopic } = await import('@/lib/bcf-drafts/draft-edit'); const before = guardedDraftBatch(i.batch_id, i.expected_modified_at);
    const edited = editDraftTopic(before, i.topic_guid, { title: i.title, description: i.description, topicType: i.topic_type, topicStatus: i.status, priority: i.priority, labels: i.labels, assignedTo: i.assigned_to });
    if (!edited.ok) throw invalidInput(edited.reason === 'unknown-topic' ? 'unknown-target' : 'refused', `Native draft edit refused: ${edited.reason}`); return saveGuardedDraftBatch(before, edited.batch, c);
  }),
  coordination<{ batch_id: string; expected_modified_at: string; topic_guid: string; comment: string }>('bcf.addDraftComment', 'Add a local draft comment through the native draft reducer.', ['configuration'], {
    type: 'object', properties: { batch_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_modified_at: { type: 'string', minLength: 1, maxLength: 100 }, topic_guid: { type: 'string', minLength: 1, maxLength: 200 }, comment: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['batch_id', 'expected_modified_at', 'topic_guid', 'comment'], additionalProperties: false,
  }, async (i, c) => { const { addDraftComment } = await import('@/lib/bcf-drafts/draft-edit'); const before = guardedDraftBatch(i.batch_id, i.expected_modified_at), edited = addDraftComment(before, i.topic_guid, i.comment); if (!edited.ok) throw invalidInput(edited.reason === 'unknown-topic' ? 'unknown-target' : 'refused', edited.reason); return saveGuardedDraftBatch(before, edited.batch, c); }),
  coordination<{ batch_id: string; expected_modified_at: string; topic_guid: string }>('bcf.deleteDraftTopic', 'Delete one exact draft topic and preserve native membership invariants.', ['configuration'], {
    type: 'object', properties: { batch_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_modified_at: { type: 'string', minLength: 1, maxLength: 100 }, topic_guid: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['batch_id', 'expected_modified_at', 'topic_guid'], additionalProperties: false,
  }, async (i, c) => { const { deleteDraftTopic } = await import('@/lib/bcf-drafts/draft-edit'); const before = guardedDraftBatch(i.batch_id, i.expected_modified_at), edited = deleteDraftTopic(before, i.topic_guid); if (!edited.ok) throw invalidInput(edited.reason === 'unknown-topic' ? 'unknown-target' : 'refused', edited.reason); return saveGuardedDraftBatch(before, edited.batch, c); }),
  coordination<{ batch_id: string; expected_modified_at: string; topic_guids: string[] }>('bcf.mergeDraftTopics', 'Merge explicit draft topics using the native ownership-aware merge reducer.', ['configuration'], {
    type: 'object', properties: { batch_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_modified_at: { type: 'string', minLength: 1, maxLength: 100 }, topic_guids: { type: 'array', minItems: 2, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } } }, required: ['batch_id', 'expected_modified_at', 'topic_guids'], additionalProperties: false,
  }, async (i, c) => { const { mergeDraftTopics } = await import('@/lib/bcf-drafts/draft-edit'); const before = guardedDraftBatch(i.batch_id, i.expected_modified_at), edited = await mergeDraftTopics(before, i.topic_guids); if (!edited.ok) throw invalidInput(edited.reason === 'unknown-topic' ? 'unknown-target' : 'refused', edited.reason); return saveGuardedDraftBatch(before, edited.batch, c); }),
  coordination('bcf.exportDraft', 'Export one native draft batch as a BCF ZIP with its native provenance footer and ownership checks.', ['artifact'], idSchema, async (i, c) => {
    const { exportDraftArchive } = await import('@/lib/bcf-drafts/draft-archive'); const { useViewerStore } = await import('@/store');
    const selected = useBcfDraftLibrary.getState().entries.find(batch => batch.id === i.id); if (!selected) throw invalidInput('unknown-target', 'Unknown draft batch.');
    const blob = await exportDraftArchive(selected, useViewerStore.getState().bcfAuthor); c.checkpoint?.(); return c.artifacts.create({ filename: 'coordination-drafts.bcfzip', mimeType: 'application/zip', data: blob });
  }),
  coordination('bcf.importDrafts', 'Read native BCF draft provenance, validate ownership and adopt imported batches without overwriting conflicting local evidence.', ['configuration'], textSchema, async (i, c) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.value)) throw invalidInput('invalid-value', 'Expected bounded base64 draft archive.');
    const [{ importDraftArchive }, { adoptImportedBatches }] = await Promise.all([import('@/lib/bcf-drafts/draft-archive'), import('@/lib/bcf-drafts/draft-library')]);
    const bytes = Uint8Array.from(decodedInput('value', () => atob(i.value)), character => character.charCodeAt(0)), imported = await importDraftArchive(bytes.buffer as ArrayBuffer); c.checkpoint?.();
    return c.commitAsync(async () => ({ imported, adopted: await adoptImportedBatches(imported.batches) }));
  }),
];
