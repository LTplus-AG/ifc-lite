/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { resolveRef } from '../refs';
import { boundedMappedPage, pageInput, pageOutputProperties, type PageRequest } from './result-limit';
import { stateRevision } from './state-revision';
import { operation, viewerOperation, pointSchema } from './contract';
const resultSchema = { type: 'object', properties: { id: { type: 'string' }, annotation_json: { type: 'string' }, persistence: { type: 'string' } }, required: ['id', 'annotation_json', 'persistence'], additionalProperties: false };
const meta = (id: string, description: string) => ({ id, owner: 'viewport', description: `${description} Pins use renderer Y-up metres and native best-effort browser persistence. Native collaboration mirroring and role checks remain authoritative.`,
  features: ['tools.annotate'] as const, effects: ['configuration', 'network'] as const, capability: 'commands-and-edits' as const, implementation: 'native-store' as const,
  synchronous: true, policy: { network: 'native-provider' as const }, outputSchema: resultSchema });
function enabled() { if (!isToolAvailable('annotate')) throw new Error('Annotation tools are disabled by the host.'); }
function result(id: string) {
  return { id, annotation_json: JSON.stringify(useViewerStore.getState().annotations.get(id) ?? null), persistence: 'native-browser-preferences-best-effort' };
}
function create(position: [number, number, number], note: string, modelId: string | null, expressId: number | null) {
  enabled();
  const s = useViewerStore.getState();
  if (s.draft) throw new Error('An annotation draft is already open; finish or cancel it first.');
  if (!note.trim()) throw new Error('A nonempty annotation note is required.');
  s.beginDraft({ x: position[0], y: position[1], z: position[2] }, expressId, modelId);
  const id = s.commitDraft(note);
  if (!id) throw new Error('Native annotation creation refused.');
  return result(id);
}
export const annotationOperations = [
  viewerOperation<PageRequest>({ id: 'annotations.read', owner: 'viewport', description: 'Read a bounded page of native annotation records, including attribution, timestamps and model/entity anchors. Pass next_offset and page_revision to continue.', effects: ['read'], capability: 'read', implementation: 'native-store', outputSchema: {
    type: 'object', properties: { total: { type: 'integer' }, ...pageOutputProperties, records: { type: 'array', items: { type: 'string' } } }, required: ['total', 'next_offset', 'page_revision', 'records'], additionalProperties: false,
  } }, { ...pageInput, properties: { ...pageInput.properties, limit: { type: 'integer', minimum: 1, maximum: 100, nullable: true } } }, i => {
    const entries = [...useViewerStore.getState().annotations.values()];
    const { items: records, offset: _offset, ...page } = boundedMappedPage(entries, entry => JSON.stringify(entry),
      { ...i, limit: i.limit ?? 25 }, null, stateRevision(entries));
    return { ...page, records };
  }),
  viewerOperation<{ position: [number, number, number]; note: string }>(meta('annotations.create', 'Create a numerical free-space native annotation, preserving any already-open human draft.'), {
    type: 'object', properties: { position: pointSchema, note: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['position', 'note'], additionalProperties: false,
  }, i => create(i.position, i.note, null, null)),
  operation<{ position: [number, number, number]; note: string; express_id: number }>(meta('annotations.createAnchored', 'Create a numerical native annotation anchored to one validated entity of the explicit model.'), {
    type: 'object', properties: { position: pointSchema, note: { type: 'string', minLength: 1, maxLength: 2000 }, express_id: { type: 'integer', minimum: 1 } }, required: ['position', 'note', 'express_id'], additionalProperties: false,
  }, (i, c) => { const ref = resolveRef(c.model, { express_id: i.express_id }); return create(i.position, i.note, ref.modelId, ref.expressId); }),
  viewerOperation<{ id: string; expected_json: string; action: 'edit' | 'delete' | 'select'; note?: string }>(meta('annotations.manage', 'Edit/delete/select an exact unchanged annotation via its native action; expected_json must match a previously read annotation record.'), {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, expected_json: { type: 'string', minLength: 1, maxLength: 10000 }, action: { type: 'string', enum: ['edit', 'delete', 'select'] }, note: { type: 'string', maxLength: 2000, nullable: true } }, required: ['id', 'expected_json', 'action'], additionalProperties: false,
  }, i => {
    enabled(); const s = useViewerStore.getState(), existing = s.annotations.get(i.id);
    if (!existing || JSON.stringify(existing) !== i.expected_json) throw new Error('The annotation changed; inspect it again.');
    if (i.action === 'edit') { if (typeof i.note !== 'string') throw new Error('note is required for edit.'); s.updateAnnotation(i.id, i.note); }
    else if (i.action === 'delete') s.removeAnnotation(i.id); else s.selectAnnotation(i.id);
    return result(i.id);
  }),
];
