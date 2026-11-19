/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { ModelAuthoringPreview } from '@/lib/actions/model-authoring-preview';
import type { ModelChangePreview } from '@/lib/actions/model-change-preview';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import type { ToolHost } from '../types';
import { operation, emptySchema, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import { admitCandidate, candidateStillApplies, libraryHoldsReceipt, persistReceipt, type ReceiptHolder } from './host-handles';

const previewOutput = { type: 'object', properties: { token: { type: 'string' }, preview_json: { type: 'string' }, revision: { type: 'integer' } }, required: ['token', 'preview_json', 'revision'], additionalProperties: false };
const receiptOutput = { type: 'object', properties: { receipt_json: { type: 'string' }, persisted: { type: 'boolean' } }, required: ['receipt_json', 'persisted'], additionalProperties: false };
const proposalInput = { type: 'object' as const, properties: { proposal_json: { type: 'string' as const, maxLength: 1000000 } }, required: ['proposal_json' as const], additionalProperties: false as const };
const tokenInput = { type: 'object' as const, properties: { token: { type: 'string' as const, minLength: 1, maxLength: 100 } }, required: ['token' as const], additionalProperties: false as const };
const meta = (id: string, owner: string, description: string, write = false) => ({ id, owner, description,
  effects: write ? ['model'] as const : ['read'] as const, capability: write ? 'commands-and-edits' as const : 'read' as const,
  implementation: 'native-store' as const, policy: write ? { model: 'native-reviewed' as const } : undefined,
  outputSchema: write ? receiptOutput : previewOutput });
interface Candidate extends ReceiptHolder {
  modelId: string; store: OperationContext['model']['store']; revision: number;
  authoring?: ModelAuthoringPreview; properties?: ModelChangePreview; receipt?: ModelChangeReceipt;
}
const owned = new WeakMap<ToolHost, Map<string, Candidate>>();
function candidates(c: OperationContext) {
  let found = owned.get(c.host); if (!found) { found = new Map(); owned.set(c.host, found); } return found;
}
/** The permanent half of apply's check: the model has not changed since the preview. */
const previewCurrent = (entry: Pick<Candidate, 'revision'>) => entry.revision === useViewerStore.getState().mutationVersion;
/** Admit `inputs` as new candidates in one synchronous step: room for all of them is made (refusing before any
 * candidate that can still apply is evicted) and all are stored, or none are. Nothing awaits between the two, so a
 * concurrent prepare cannot take the room. */
function rememberAll<T extends object>(c: OperationContext, inputs: ReadonlyArray<{ input: Omit<Candidate, 'modelId' | 'store' | 'revision'>; preview: T }>) {
  const entries = candidates(c), stillApplies = candidateStillApplies(c.host);
  admitCandidate(entries, { cap: 64, refusal: 'At most 64 reviewed model candidates may be retained by a host.', pending: entry => !libraryHoldsReceipt(entry),
    canApply: entry => stillApplies(entry.receipt !== undefined, () => previewCurrent(entry), entry), count: inputs.length });
  const revision = useViewerStore.getState().mutationVersion;
  return inputs.map(({ input, preview }) => {
    const token = crypto.randomUUID();
    entries.set(token, { ...input, modelId: c.model.id, store: c.model.store, revision });
    return { token, revision, preview_json: JSON.stringify(preview) };
  });
}
const remember = (c: OperationContext, input: Omit<Candidate, 'modelId' | 'store' | 'revision'>, preview: object) => rememberAll(c, [{ input, preview }])[0];
function ownedCandidate(c: OperationContext, token: string) {
  const saved = candidates(c).get(token);
  if (!saved || saved.modelId !== c.model.id || saved.store !== c.model.store) throw new Error('Unknown reviewed candidate for this host and model.');
  return saved;
}
function candidate(c: OperationContext, token: string) {
  const saved = ownedCandidate(c, token);
  if (!saved.receipt && !previewCurrent(saved)) throw new Error('Model changed since preview; prepare again.');
  return saved;
}
async function persist(saved: Candidate, receipt: ModelChangeReceipt) {
  return { receipt_json: JSON.stringify(receipt), persisted: await persistReceipt(saved, receipt) };
}
/** Preview each property batch, changing nothing, then admit them all at once: a failure or a refusal at any point
 * leaves the host as it was, apart from stale candidates admission drops anyway. */
export async function preparePropertyCandidates(c: OperationContext, proposals: readonly string[]) {
  const [{ parseModelChangeBatch }, { previewModelChanges }] = await Promise.all([import('@ifc-lite/ai/artifacts'), import('@/lib/actions/model-change-preview')]);
  assertToolActive(c);
  const previews = proposals.map(proposal => {
    const preview = previewModelChanges(useViewerStore.getState(), parseModelChangeBatch(proposal));
    if (preview.rows.some(row => row.modelId !== null && row.modelId !== c.model.id)) throw new Error('All reviewed properties must belong to the selected model.');
    return { input: { properties: preview }, preview };
  });
  return rememberAll(c, previews);
}


export const authoringOperations = [
  operation({ ...meta('authoring.describe', 'model', 'Discover the complete native reviewed authoring vocabulary and its exact input guidance. No arbitrary STEP or method-path execution.'), outputSchema: {
    type: 'object', properties: { operations: { type: 'array', items: { type: 'string' } }, guidance: { type: 'string' } }, required: ['operations', 'guidance'], additionalProperties: false,
  } }, emptySchema, async () => {
    const [{ AUTHORING_OPS }, { MODEL_AUTHORING_OUTPUT_GUIDANCE }] = await Promise.all([import('@/lib/actions/model-authoring'), import('@/lib/actions/model-authoring-guidance')]);
    return { operations: AUTHORING_OPS, guidance: MODEL_AUTHORING_OUTPUT_GUIDANCE };
  }),
  operation<{ proposal_json: string }>(meta('authoring.prepare', 'model', 'Prepare a complete canonical model.authoring proposal through the native parser, alignment preparation and detached native dry run. All rows must resolve to the selected model. Preview contains real before/after expectations, availability and dependencies.'), proposalInput, async (i, c) => {
    const [{ parseModelAuthoringBatch }, { previewModelAuthoring }, { prepareReviewedAlignments }] = await Promise.all([
      import('@/lib/actions/model-authoring'), import('@/lib/actions/model-authoring-preview'), import('@/lib/actions/model-authoring-align'),
    ]);
    assertToolActive(c);
    const batch = parseModelAuthoringBatch(i.proposal_json);
    await prepareReviewedAlignments(useViewerStore.getState, batch, c.signal);
    assertToolActive(c);
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    if (preview.rows.some(row => row.modelId !== null && row.modelId !== c.model.id)) throw new Error('An operation may only review the explicitly selected model.');
    return remember(c, { authoring: preview }, preview);
  }),
  operation<{ proposal_json: string }>(meta('properties.prepare', 'properties', 'Prepare a canonical model.changes batch for property, quantity or exact IFC attribute edits. Native expected-value checks and role gates are preserved.'), proposalInput, async (i, c) => {
    return (await preparePropertyCandidates(c, [i.proposal_json]))[0];
  }),
  operation<{ token: string }>(meta('authoring.apply', 'model', 'Apply every ready row of the exact prepared model/attribute/property candidate as a native transaction. Refuses an incomplete/conflicting preview; repeated apply returns the same receipt.', true), tokenInput, async (i, c) => {
    const saved = candidate(c, i.token);
    if (saved.receipt) return persist(saved, saved.receipt);
    const [{ commitModelAuthoring }, { commitModelChanges }] = await Promise.all([import('@/lib/actions/model-authoring-commit'), import('@/lib/actions/model-change-commit')]);
    candidate(c, i.token); assertToolActive(c);
    const preview = saved.authoring ?? saved.properties!;
    if (preview.rows.some(row => row.status !== 'ready' && row.status !== 'unchanged')) throw new Error('The preview contains refused/conflicting rows. Prepare a complete valid candidate.');
    const approved = new Set(preview.rows.filter(row => row.status === 'ready').map(row => row.index));
    // A refusal throws inside commit, so it is not recorded as a committed write.
    const outcome = c.commit(() => {
      const result = saved.authoring ? commitModelAuthoring(useViewerStore, saved.authoring, approved, 'viewer-agent')
        : commitModelChanges(useViewerStore, saved.properties!, approved, 'viewer-agent');
      if (!result.ok) throw new Error(`Native commit refused: ${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
      return result;
    });
    saved.receipt = outcome.receipt; return persist(saved, outcome.receipt);
  }),
  operation<{ token: string }>({ ...meta('authoring.discard', 'model', 'Discard a prepared model candidate without applying it.'), outputSchema: { type: 'object', properties: { discarded: { type: 'boolean' } }, required: ['discarded'], additionalProperties: false } }, tokenInput, (i, c) => {
    // No revision check: a stale candidate is exactly the one worth discarding.
    ownedCandidate(c, i.token); candidates(c).delete(i.token); return { discarded: true };
  }),
];
