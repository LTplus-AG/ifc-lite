/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { operation, viewerOperation, emptySchema, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ChangeOperation } from '@/lib/changes/change-operations';
import type { ToolHost } from '../types';
import { invalidInput, stale, unavailable } from './refusals';
import { evictOldest, retainCandidate } from './host-handles';
import { readJsonArtifactText } from './artifacts';

const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, owner: string, description: string, effect: 'read' | 'model' | 'configuration' | 'artifact' | 'selection' = 'read') => ({ id, owner, description,
  effects: [effect], capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const,
  implementation: 'native-store' as const, outputSchema,
  policy: effect === 'model' ? { model: 'native-reviewed' as const } : effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
const idInput = { type: 'object' as const, properties: { id: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['id' as const], additionalProperties: false as const };
async function allOperations() {
  const [{ changeOperations }, { inverseMutationTargets }] = await Promise.all([import('@/lib/changes/change-operations'), import('@/store/slices/mutation-inverse-registry')]);
  const state = useViewerStore.getState(); return changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore));
}
async function operations(c: OperationContext) { return (await allOperations()).filter(operation => operation.modelIds.every(id => id === c.model.id)); }
const reviews = new WeakMap<ToolHost, Map<string, ChangeOperation>>();
function owned(c: OperationContext) { let entries = reviews.get(c.host); if (!entries) { entries = new Map(); reviews.set(c.host, entries); } return entries; }
function requireSet(id: string) {
  const set = useViewerStore.getState().changeSets.get(id); if (!set) throw invalidInput('unknown-target', 'Unknown change set.'); return set;
}
export const changesOperations = [
  operation(meta('changes.read', 'changes', 'Read native change operations for the selected model, including stable operation IDs, exact mutation records and current top-of-history state.'), emptySchema, async (_, c) => out(await operations(c))),
  operation<{ id: string }>({ ...meta('changes.revert.prepare', 'changes', 'Capture the exact native operation to revert. Apply rechecks native conflicts and shared-session restrictions.'), outputSchema: { type: 'object', properties: { token: { type: 'string' }, native_json: { type: 'string' } }, required: ['token', 'native_json'] } }, idInput, async (i, c) => {
    const entry = (await operations(c)).find(row => row.id === i.id); if (!entry) throw invalidInput('unknown-target', 'Unknown current native change operation.');
    assertToolActive(c); evictOldest(owned(c), 64); const token = crypto.randomUUID();
    retainCandidate(c, owned(c), token, entry); return { token, native_json: JSON.stringify(entry) };
  }),
  operation<{ token: string }>(meta('changes.revert.apply', 'changes', 'Revert the captured native operation through the existing conflict-aware Changes-panel handler. Shared rooms and stale/overwritten values remain refused.', 'model'), {
    type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false,
  }, async (i, c) => {
    const entry = owned(c).get(i.token); if (!entry) throw invalidInput('unknown-target', 'Unknown revert candidate for this host.');
    if (entry.modelIds.some(id => id !== c.model.id)) throw invalidInput('wrong-target', 'Wrong model for this revert.');
    const { revertChangeOperation } = await import('@/lib/changes/revert-change-operation');
    const result = c.commit(() => {
      const reverted = revertChangeOperation(useViewerStore, entry);
      if (!reverted.ok) {
        const message = `Native revert refused: ${reverted.reason}`;
        throw reverted.reason === 'stale' || reverted.reason === 'newer-conflict'
          ? stale(message) : invalidInput('refused', message);
      }
      return reverted;
    });
    owned(c).delete(i.token); return out(result);
  }),
  operation<{ direction: 'undo' | 'redo' }>(meta('changes.history', 'changes', 'Undo or redo the selected model through its native SDK history; native mutation/role gates remain active.', 'model'), {
    type: 'object', properties: { direction: { type: 'string', enum: ['undo', 'redo'] } }, required: ['direction'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => ({ changed: i.direction === 'undo' ? c.model.bim.mutate.undo(c.model.id) : c.model.bim.mutate.redo(c.model.id) })))),
  operation<{ express_id: number }>(meta('changes.select', 'changes', 'Select and frame a changed entity through the native Changes-panel selection handler.', 'selection'), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 } }, required: ['express_id'], additionalProperties: false,
  }, async (i, c) => {
    const { selectChangedEntity } = await import('@/lib/changes/select-changed-entity');
    // Only an entity a current change touched; anything else is a plain selection (#10793).
    // A federated batch also counts: the Changes panel lists its entities per model.
    if (!(await allOperations()).some(row => row.entities.some(entity => entity.modelId === c.model.id && entity.entityId === i.express_id))) throw invalidInput('unknown-target', 'No current native change touches that entity.'); assertToolActive(c);
    return out(c.commit(() => ({ selected: selectChangedEntity(c.model.id, i.express_id) })));
  }),
  viewerOperation(meta('changeSets.read', 'changeSets', 'Read all native change sets, active collection target and exact grouped contents. Importing a set stages its records and never applies its edits.'), emptySchema, async () => {
    const { changeSetSummaries, groupChangeSetByElement } = await import('@/lib/change-sets/change-set-view'); const s = useViewerStore.getState();
    return out({ active: s.activeChangeSetId, sets: changeSetSummaries(s.changeSets, s.activeChangeSetId), contents: [...s.changeSets].map(([id, set]) => ({ id, groups: groupChangeSetByElement(set) })) });
  }),
  viewerOperation<{ name: string }>(meta('changeSets.create', 'changeSets', 'Create and activate a native change set for subsequent native edits.', 'configuration'), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['name'], additionalProperties: false,
  }, async (i, c) => { const { createChangeSet } = await import('@/lib/change-sets/change-set-actions'); return out(c.commit(() => ({ id: createChangeSet(i.name) }))); }),
  viewerOperation<{ id: string; name: string }>(meta('changeSets.rename', 'changeSets', 'Rename an existing native change set.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id', 'name'], additionalProperties: false,
  }, async (i, c) => { const { renameChangeSet } = await import('@/lib/change-sets/change-set-actions'); return out(c.commit(() => { requireSet(i.id); renameChangeSet(i.id, i.name); return { renamed: i.id }; })); }),
  viewerOperation<{ id: string }>(meta('changeSets.activate', 'changeSets', 'Activate an existing set. An empty ID stops collecting edits.', 'configuration'), {
    type: 'object', properties: { id: { type: 'string', maxLength: 200 } }, required: ['id'], additionalProperties: false,
  }, async (i, c) => { const { activateChangeSet } = await import('@/lib/change-sets/change-set-actions'); return out(c.commit(() => { if (i.id) requireSet(i.id); activateChangeSet(i.id || null); return { active: i.id || null }; })); }),
  viewerOperation<{ id: string }>(meta('changeSets.discard', 'changeSets', 'Discard a set record through the native panel handler. The edits remain in the model, matching the panel behavior.', 'configuration'), idInput,
    async (i, c) => { const { discardChangeSet } = await import('@/lib/change-sets/change-set-actions'); return out(c.commit(() => { requireSet(i.id); discardChangeSet(i.id); return { discarded: i.id }; })); }),
  viewerOperation<{ json?: string | null; artifact_id?: string | null }>(meta('changeSets.import', 'changeSets', 'Import a native change set from inline json or a host-owned JSON artifact_id (up to 16 MiB). This stages metadata and does not replay edits.', 'configuration'), {
    type: 'object', properties: { json: { type: 'string', nullable: true, maxLength: 1000000 },
      artifact_id: { type: 'string', nullable: true, minLength: 1, maxLength: 200 } }, required: [], additionalProperties: false,
    oneOf: [
      { properties: { json: { type: 'string' } }, required: ['json'] },
      { properties: { artifact_id: { type: 'string' } }, required: ['artifact_id'] },
    ],
  }, async (i, c) => {
    const { importChangeSet } = await import('@/lib/change-sets/change-set-actions');
    assertToolActive(c);
    const json = i.artifact_id == null ? i.json : await readJsonArtifactText(c.host, i.artifact_id, 16 * 1024 * 1024);
    assertToolActive(c);
    return out(c.commit(() => {
      const id = json == null ? null : importChangeSet(json);
      if (!id) throw invalidInput('invalid-value', 'Invalid native change-set file.');
      return { id, applied: false };
    }));
  }),
  viewerOperation<{ id: string }>({ ...meta('changeSets.export', 'changeSets', 'Create a host-owned JSON artifact using the native change-set exporter.', 'artifact'), outputSchema: { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'] } }, idInput,
    async (i, c) => { const [{ exportChangeSet }, { changeSetFileName }] = await Promise.all([import('@/lib/change-sets/change-set-actions'), import('@/lib/change-sets/change-set-view')]);
      const set = requireSet(i.id), json = exportChangeSet(i.id); if (!json) throw unavailable('Change set is unavailable.'); assertToolActive(c);
      return c.artifacts.create({ filename: changeSetFileName(set.name), mimeType: 'application/json', data: json }); }),
];
