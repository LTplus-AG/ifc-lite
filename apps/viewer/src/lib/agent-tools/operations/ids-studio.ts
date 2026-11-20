/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import type { StudioDocument, StudioOp } from '@ifc-lite/ids-authoring';
import { useViewerStore } from '@/store';
import { viewerOperation as nativeOperation, operation as modelOperation, emptySchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import { decodedInput, disabled, invalidInput, stale, unavailable, parseJsonInput } from './refusals';
import { admitCandidate, candidateStillApplies } from './host-handles';

const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
function operation<T>(...args: Parameters<typeof nativeOperation<T>>) {
  const [metadata, schema, handler] = args;
  return nativeOperation<T>({ ...metadata, outputSchema: jsonOutput }, schema, async (input, context) => ({ native_json: JSON.stringify(await handler(input, context)) }));
}
const artifactOutput = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
const meta = (id: string, description: string, write = false) => ({ id, owner: 'idsStudio', description,
  effects: write ? ['configuration'] as const : ['read'] as const,
  capability: write ? 'commands-and-edits' as const : 'read' as const, implementation: 'native-store' as const });
function current() {
  const state = useViewerStore.getState();
  if (!state.idsStudioState) throw unavailable('No IDS Studio document is open.');
  return state.idsStudioState;
}
function writeGuard(c: ViewerOperationContext) {
  assertToolActive(c);
  if (!c.canEdit?.()) throw disabled('The commands and edits grant is required.');
}
async function dependencies(c: ViewerOperationContext) {
  const { loadStudioContexts } = await import('@/lib/ids-studio/context');
  const contexts = await loadStudioContexts();
  assertToolActive(c);
  return contexts;
}
async function saveOpenDraft(c: ViewerOperationContext) {
  const { saveOpenIdsDraft } = await import('@/lib/ids-studio/draft-viewer');
  await saveOpenIdsDraft();
  assertToolActive(c);
}
function read() {
  const state = useViewerStore.getState();
  return { revision: state.idsStudioRevision, document: state.idsStudioState?.doc ?? null,
    selected: state.idsStudioSelection, rejection: state.idsStudioRejection };
}
interface Candidate { revision: number; document?: StudioDocument; ops?: StudioOp[]; result?: unknown }
const hosts = new WeakMap<object, Map<string, Candidate>>();
function candidates(c: ViewerOperationContext) {
  let entries = hosts.get(c.host); if (!entries) { entries = new Map(); hosts.set(c.host, entries); const captured = entries; c.host.lifetimeSignal?.addEventListener('abort', () => captured.clear(), { once: true }); } return entries;
}
function remember(c: ViewerOperationContext, candidate: Candidate) {
  assertToolActive(c); // a prepare cancelled during its imports must not evict another candidate
  // IDS candidates are bound to the document revision, as apply's revision() checks, not to a model.
  const revision = useViewerStore.getState().idsStudioRevision, stillApplies = candidateStillApplies();
  admitCandidate(candidates(c), { cap: 64, refusal: 'IDS candidate capacity reached; apply or discard a pending candidate.',
    pending: entry => entry.result === undefined, canApply: entry => stillApplies(entry.result !== undefined, () => entry.revision === revision) });
  const token = crypto.randomUUID(); candidates(c).set(token, candidate); return token;
}
const tokenSchema: JSONSchemaType<{ token: string }> = { type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false };
const jsonSchema: JSONSchemaType<{ ops_json: string; document_revision: number }> = { type: 'object', properties: {
  ops_json: { type: 'string', maxLength: 1000000 }, document_revision: { type: 'integer', minimum: 0 },
}, required: ['ops_json', 'document_revision'], additionalProperties: false };
function revision(expected: number) {
  if (useViewerStore.getState().idsStudioRevision !== expected) throw stale('The IDS document changed. Inspect and prepare again.');
}

export const idsOperations = [
  operation(meta('ids.document.read', 'Read the current structured IDS document, node identities and revision.'), emptySchema, read),
  operation(meta('ids.operations.schema', 'Discover the canonical complete StudioOp vocabulary and runtime JSON Schema (specs, facets, values, metadata and comments).'), emptySchema, async () => {
    const { getOpJsonSchema, OP_KINDS } = await import('@ifc-lite/ids-authoring'); return { kinds: OP_KINDS, schema: getOpJsonSchema() };
  }),
  operation<{ format: 'new' | 'xml' | 'idsz'; content: string; document_revision: number }>(meta('ids.document.prepare', 'Prepare an immutable new/imported IDS document; XML or base64 IDSZ. Does not replace the open document.'), {
    type: 'object', properties: { format: { type: 'string', enum: ['new', 'xml', 'idsz'] }, content: { type: 'string', maxLength: 2000000 }, document_revision: { type: 'integer', minimum: 0 } },
    required: ['format', 'content', 'document_revision'], additionalProperties: false,
  }, async (i, c) => {
    revision(i.document_revision);
    const contexts = await dependencies(c); void contexts;
    const { createStudioDocument } = await import('@ifc-lite/ids-authoring');
    const { importIdsXml, importIdsz } = await import('@/lib/ids-studio/import');
    const parsed = i.format === 'new' ? { ok: true as const, doc: createStudioDocument({ title: i.content }) }
      : i.format === 'xml' ? importIdsXml(i.content) : importIdsz(Uint8Array.from(decodedInput('content', () => atob(i.content)), ch => ch.charCodeAt(0)));
    if (!parsed.ok) throw invalidInput('invalid-value', parsed.error);
    revision(i.document_revision); assertToolActive(c);
    const document = structuredClone(parsed.doc);
    return { token: remember(c, { revision: i.document_revision, document }), document, revision: i.document_revision };
  }),
  operation(meta('ids.operations.prepare', 'Validate and ground a complete StudioOp batch through the native schema/gate/reducer. Returns an immutable revision-bound candidate and its resulting document.'), jsonSchema, async (i, c) => {
    revision(i.document_revision);
    const contexts = await dependencies(c);
    const { validateOp } = await import('@ifc-lite/ids-authoring');
    const { dispatchStudioOps } = await import('@/lib/ids-studio/session');
    const raw: unknown = parseJsonInput(i.ops_json, 'ops_json');
    if (!Array.isArray(raw) || raw.length > 500) throw invalidInput('limit', 'ops_json must contain at most 500 canonical StudioOps.');
    const ops = raw.map(value => { const parsed = validateOp(value); if (!parsed.ok) throw invalidInput('invalid-value', JSON.stringify(parsed.errors)); return parsed.op; });
    revision(i.document_revision);
    const result = dispatchStudioOps(current(), ops, contexts.gate, { label: 'Agent IDS candidate' });
    if (!result.ok) return { accepted: false, issues: result.issues };
    return { accepted: true, token: remember(c, { revision: i.document_revision, ops: structuredClone(ops) }), document: result.state.doc, revision: i.document_revision };
  }),
  operation(meta('ids.candidate.apply', 'Apply exactly one prepared IDS candidate through native open or gated dispatch; one native history step for an op batch. Repeated apply does not duplicate edits.', true), tokenSchema, async (i, c) => {
    const candidate = candidates(c).get(i.token);
    if (!candidate) throw invalidInput('unknown-target', 'Unknown IDS candidate for this model session.');
    if (candidate.result !== undefined) { writeGuard(c); return candidate.result; }
    revision(candidate.revision);
    const contexts = await dependencies(c);
    // A whole-document candidate replaces the open draft. Check that it still owns the revision before saving.
    if (candidate.document && candidate.result === undefined && useViewerStore.getState().idsStudioDraftId) {
      revision(candidate.revision); writeGuard(c);
      await saveOpenDraft(c);
    }
    // Another apply of this token finished during the await: it dispatched once, so answer as a replay.
    if (candidate.result !== undefined) { writeGuard(c); return candidate.result; }
    revision(candidate.revision); writeGuard(c);
    candidate.result = c.commit(() => {
      if (candidates(c).get(i.token) !== candidate) throw stale('The IDS candidate was discarded. Prepare it again.');
      const state = useViewerStore.getState(); state.idsStudioSetContexts(contexts);
      if (candidate.document) state.idsStudioOpen(structuredClone(candidate.document));
      else {
        const result = state.idsStudioDispatch(candidate.ops ?? [], { label: 'Agent IDS edit' });
        if (!result.ok) throw invalidInput('invalid-value', JSON.stringify(result.issues));
      }
      return read();
    }); return candidate.result;
  }),
  operation(meta('ids.candidate.discard', 'Discard a pending IDS candidate.', true), tokenSchema, (i, c) => { writeGuard(c); const candidate = candidates(c).get(i.token);
    if (!candidate) throw invalidInput('unknown-target', 'Unknown IDS candidate.');
    candidates(c).delete(i.token); return { discarded: true };
  }),
  operation(meta('ids.lint', 'Lint the current document through the native IDS Studio linter and IFC grounding tables.'), emptySchema, async (_, c) => {
    const document = current().doc, expected = useViewerStore.getState().idsStudioRevision;
    const contexts = await dependencies(c); const { lintDocument } = await import('@ifc-lite/ids-authoring'); revision(expected);
    return { revision: expected, diagnostics: lintDocument(document, contexts.lint) };
  }),
  operation<{ document_revision: number; direction: 'undo' | 'redo' }>(meta('ids.history', 'Undo or redo one gated native IDS history entry.', true), { type: 'object', properties: {
    document_revision: { type: 'integer', minimum: 0 }, direction: { type: 'string', enum: ['undo', 'redo'] },
  }, required: ['document_revision', 'direction'], additionalProperties: false }, async (i, c) => {
    await dependencies(c); revision(i.document_revision); writeGuard(c);
    return c.commit(() => { if (i.direction === 'undo') useViewerStore.getState().idsStudioUndo(); else useViewerStore.getState().idsStudioRedo(); return read(); });
  }),
  operation(meta('ids.document.xml', 'Render current IDS XML through the same writer used by the panel and export.'), emptySchema, async () => {
    const { exportIds } = await import('@/lib/ids-studio/export'); const written = exportIds(current().doc);
    if (!written.ok) throw unavailable(written.error); return written;
  }),
  operation(meta('ids.document.bundle', 'Return the current native IDSZ bundle as base64, preserving node identities and sidecar metadata.'), emptySchema, async () => {
    const { exportIdsz } = await import('@/lib/ids-studio/export'); const written = exportIdsz(current().doc);
    if (!written.ok) throw unavailable(written.error);
    let binary = ''; for (let i = 0; i < written.content.length; i += 0x8000) binary += String.fromCharCode(...written.content.subarray(i, i + 0x8000));
    return { filename: written.fileName, content_base64: btoa(binary), media_type: 'application/zip' };
  }),
  nativeOperation<{ format: 'ids' | 'idsz' }>({ ...meta('ids.document.export', 'Export the current IDS or IDSZ through the native writer as a host-owned artifact.', true), effects: ['artifact'], policy: { artifact: 'native-export' }, outputSchema: artifactOutput }, {
    type: 'object', properties: { format: { type: 'string', enum: ['ids', 'idsz'] } }, required: ['format'], additionalProperties: false,
  }, async (i, c) => {
    const expected = useViewerStore.getState().idsStudioRevision;
    const { exportIds, exportIdsz } = await import('@/lib/ids-studio/export');
    const written = i.format === 'ids' ? exportIds(current().doc) : exportIdsz(current().doc);
    if (!written.ok) throw unavailable(written.error);
    revision(expected); assertToolActive(c);
    return c.artifacts.create({ filename: written.fileName, mimeType: i.format === 'ids' ? 'application/xml' : 'application/zip', data: written.content });
  }),
  operation<{ document_revision: number }>(meta('ids.document.close', 'Close the native IDS document after checking its exact revision.', true), {
    type: 'object', properties: { document_revision: { type: 'integer', minimum: 0 } }, required: ['document_revision'], additionalProperties: false,
  }, async (i, c) => {
    revision(i.document_revision); writeGuard(c); await saveOpenDraft(c); revision(i.document_revision); writeGuard(c);
    return c.commit(() => { useViewerStore.getState().idsStudioClose(); return read(); });
  }),
  operation<{ document_revision: number; view: 'inspector' | 'xml'; selection_id: string }>(meta('ids.settings', 'Set the native Studio view and selected document/spec/facet node; empty selection_id clears selection.', true), {
    type: 'object', properties: { document_revision: { type: 'integer', minimum: 0 }, view: { type: 'string', enum: ['inspector', 'xml'] }, selection_id: { type: 'string', maxLength: 100 } }, required: ['document_revision', 'view', 'selection_id'], additionalProperties: false,
  }, async (i, c) => {
    await dependencies(c); const { isUuid } = await import('@ifc-lite/ids-authoring'); revision(i.document_revision); writeGuard(c);
    const s = useViewerStore.getState(), doc = current().doc;
    if (i.selection_id && (!isUuid(i.selection_id) || (doc.nodes.document !== i.selection_id && !s.idsStudioRuntime?.locateNode(doc, i.selection_id)))) throw invalidInput('unknown-target', 'Unknown current IDS node.');
    return c.commit(() => { s.idsStudioSetView(i.view); s.idsStudioSelect(i.selection_id && isUuid(i.selection_id) ? i.selection_id : null); return read(); });
  }),
  modelOperation({ ...meta('ids.document.validate', 'Validate the open Studio document against the selected effective IFC model through the existing IDS validation service.'), outputSchema: jsonOutput }, emptySchema, async (_, c) => {
    const documentRevision = useViewerStore.getState().idsStudioRevision;
    const { exportIds } = await import('@/lib/ids-studio/export'); const written = exportIds(current().doc);
    if (!written.ok) throw unavailable(written.error);
    const { validateIdsAgainst } = await import('../ids-tools'); const result = await validateIdsAgainst(c.model, written.content, c); revision(documentRevision);
    return { native_json: JSON.stringify({ revision: documentRevision, report: result.output.structured }) };
  }),
];
