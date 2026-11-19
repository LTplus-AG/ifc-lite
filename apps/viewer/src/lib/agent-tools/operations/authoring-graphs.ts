/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import type { OperationContext } from './contract';
import type { ToolHost } from '../types';
import { operation, emptySchema, referenceSchema } from './contract';
import { assertToolActive } from '../cancellation';
import { resolveRef } from '../refs';
import { admitCandidate, candidateStillApplies, persistReceipt, type ReceiptHolder } from './host-handles';

const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const tokenInput = { type: 'object' as const, properties: { token: { type: 'string' as const, minLength: 1, maxLength: 100 } }, required: ['token' as const], additionalProperties: false as const };
const previewOutput = { type: 'object', properties: { token: { type: 'string' }, preview_json: { type: 'string' } }, required: ['token', 'preview_json'], additionalProperties: false };
const meta = (id: string, owner: string, description: string, write = false) => ({ id, owner, description,
  effects: write ? ['model'] as const : ['read'] as const, capability: write ? 'commands-and-edits' as const : 'read' as const,
  implementation: 'native-store' as const, policy: write ? { model: 'native-reviewed' as const } : undefined, outputSchema: jsonOutput });
interface Review { room?: import('@/lib/actions/room-review').RoomReview; preview: object; validate(): void; sourcesCurrent(): boolean; commit(): ModelChangeReceipt; dispose?(): void }
interface Candidate extends ReceiptHolder { store: OperationContext['model']['store']; modelId: string; review?: Review; receipt?: ModelChangeReceipt }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: OperationContext) {
  let entries = hosts.get(c.host);
  if (!entries) {
    entries = new Map(); hosts.set(c.host, entries);
    const captured = entries;
    c.host.lifetimeSignal?.addEventListener('abort', () => { for (const candidate of captured.values()) candidate.review?.dispose?.(); captured.clear(); }, { once: true });
  }
  return entries;
}
const output = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
function proposalModel(value: { modelId: string }, c: OperationContext) { if (value.modelId !== c.model.id) throw new Error('The proposal must name the selected model.'); }
async function prepare(kind: 'group' | 'structural' | 'zone' | 'room', json: string, c: OperationContext): Promise<Review> {
  switch (kind) {
    case 'group': {
      const [{ parseGroupProposal }, { prepareGroupReview }, { commitReviewedGroup }] = await Promise.all([import('@/lib/actions/group-lifecycle-proposal'), import('@/lib/actions/group-lifecycle-review'), import('@/lib/actions/group-lifecycle-receipt')]);
      const proposal = parseGroupProposal(json); proposalModel(proposal, c);
      const review = prepareGroupReview(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, delta: review.delta }, validate: review.validate, sourcesCurrent: review.sourcesCurrent,
        commit: () => commitReviewedGroup(useViewerStore, review, 'viewer-agent') };
    }
    case 'structural': {
      const [{ parseStructuralProposal }, { prepareStructuralReview }, { commitReviewedStructural }] = await Promise.all([import('@/lib/actions/structural-graph-proposal'), import('@/lib/actions/structural-graph-review'), import('@/lib/actions/structural-graph-receipt')]);
      const proposal = parseStructuralProposal(json); proposalModel(proposal, c);
      const review = prepareStructuralReview(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, delta: review.delta }, validate: review.validate, sourcesCurrent: review.sourcesCurrent,
        commit: () => commitReviewedStructural(useViewerStore, review, 'viewer-agent') };
    }
    case 'zone': {
      const [{ parseZoneEmissionProposal }, { prepareZoneEmission }] = await Promise.all([import('@/lib/actions/zone-emission-proposal'), import('@/lib/actions/zone-emission-review')]);
      const proposal = parseZoneEmissionProposal(json); proposalModel(proposal, c);
      const review = prepareZoneEmission(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, dry: review.dry }, validate: review.validate, sourcesCurrent: review.sourcesCurrent, commit: () => review.commit('viewer-agent') };
    }
    case 'room': {
      const [{ parseRoomProposal }, { prepareRoomReview }, { commitReviewedRoom }] = await Promise.all([import('@/lib/actions/room-command-proposal'), import('@/lib/actions/room-review'), import('@/lib/actions/room-receipt')]);
      const proposal = parseRoomProposal(json); proposalModel(proposal, c);
      const review = await prepareRoomReview(proposal, c.signal ?? new AbortController().signal);
      return { room: review, preview: { proposal: review.proposal, snapshot: review.snapshot, result: review.prepared.result }, validate: review.validate, sourcesCurrent: review.sourcesCurrent,
        commit: () => commitReviewedRoom(review, 'viewer-agent').receipt, dispose: review.dispose };
    }
  }
}
export const graphAuthoringOperations = [
  operation({ ...meta('authoring.graphs.describe', 'model', 'Describe canonical reviewed generic Group memberships, Structural graphs, evaluated zone emission and Room command proposals.'), outputSchema: jsonOutput }, emptySchema, async () => {
    const [groups, structural, zones, rooms] = await Promise.all([import('@/lib/actions/group-lifecycle-proposal'), import('@/lib/actions/structural-graph-proposal'), import('@/lib/actions/zone-emission-proposal'), import('@/lib/actions/room-command-proposal')]);
    return output({ group: groups.GROUP_LIFECYCLE_GUIDANCE, structural: structural.STRUCTURAL_GRAPH_GUIDANCE, zone: zones.ZONE_EMISSION_GUIDANCE, room: rooms.ROOM_COMMAND_GUIDANCE });
  }),
  operation(meta('authoring.nativeEvidence', 'model', 'Read complete bounded native authoring grounding for validated entities: identities, dimensions, profiles, placement, type/material layers, replacement, split, hosted fills, reach/trim, stairs, grid, Storey reassignment, Group memberships, Structural and zone evidence. Uses the same pure capture as the Assistant without changing selection; unavailable/truncated pins stay explicit.'), referenceSchema, async (i, c) => {
    const refs = i.express_ids.map(express_id => resolveRef(c.model, { express_id }));
    const [{ captureSelectionGrounding }, { toGlobalIdForRef }] = await Promise.all([
      import('@/lib/actions/selection-grounding'), import('@/store/globalId'),
    ]);
    assertToolActive(c);
    const state = useViewerStore.getState();
    const capture = captureSelectionGrounding({ ...state, selectedEntityId: null,
      selectedEntityIds: new Set(refs.map(ref => toGlobalIdForRef(state.models, ref))) });
    return output(capture);
  }),
  ...(['group', 'structural', 'zone', 'room'] as const).map(kind => operation<{ proposal_json: string }>({ ...meta(`authoring.${kind}.prepare`, kind === 'zone' ? 'zones' : 'model', `Prepare the canonical ${kind} proposal using its native detached planner and complete evidence. Room supports pick/auto/autoAll/footprint/update/edit; no invented pointer gestures.`), outputSchema: previewOutput }, {
    type: 'object', properties: { proposal_json: { type: 'string', maxLength: 1000000 } }, required: ['proposal_json'], additionalProperties: false,
  }, async (i, c) => {
    // Unchanged by the review's own cheap probe, the permanent half of its validate(): loaded models and edit revisions
    // for Group and Structural, plus geometry identity for Room, and source owners plus zone configuration for Zone.
    // A review that fails it is dropped and its native handles released.
    const admit = () => {
      const stillApplies = candidateStillApplies(c.host);
      admitCandidate(owned(c), { cap: 32, refusal: 'At most 32 graph review candidates may be retained.', pending: entry => !entry.handedOff,
        canApply: entry => stillApplies(entry.receipt !== undefined, () => entry.review?.sourcesCurrent() ?? false, entry),
        release: entry => entry.review?.dispose?.() });
    };
    admit();
    const review = await prepare(kind, i.proposal_json, c);
    // Again after the await: a concurrent prepare may have taken the last place.
    try { assertToolActive(c); review.validate(); admit(); } catch (error) { review.dispose?.(); throw error; }
    const token = crypto.randomUUID(); owned(c).set(token, { modelId: c.model.id, store: c.model.store, review });
    return { token, preview_json: JSON.stringify(review.preview) };
  })),
  operation<{ token: string }>(meta('authoring.graph.apply', 'model', 'Apply one exact prepared native graph/Room candidate through its native synchronous review commit. Preserves all native roles, source/evidence checks and native undo. A token applies once.', true), tokenInput, async (i, c) => {
    const entry = owned(c).get(i.token);
    if (!entry || entry.modelId !== c.model.id || entry.store !== c.model.store) throw new Error('Unknown graph review for this host/model.');
    if (!entry.receipt) {
      const review = entry.review!;
      entry.receipt = c.commit(() => { review.validate(); return review.commit(); });
      review.dispose?.(); entry.review = undefined;
    }
    return output({ receipt: entry.receipt, persisted: await persistReceipt(entry, entry.receipt) });
  }),
  operation<{ token: string }>(meta('authoring.graph.discard', 'model', 'Dispose a native graph or Room preview and release its native handles.'), tokenInput, (i, c) => {
    const entry = owned(c).get(i.token);
    if (!entry || entry.modelId !== c.model.id || entry.store !== c.model.store) throw new Error('Unknown graph review.');
    entry.review?.dispose?.(); owned(c).delete(i.token); return output({ discarded: true });
  }),
];

/** Capture only the actual live prepared RoomReview owned by this host. */
export async function captureRoomGroundingForCandidate(host:ToolHost,token:string,modelId:string){
  const candidate=hosts.get(host)?.get(token),model=useViewerStore.getState().models.get(modelId);
  if(!candidate||candidate.modelId!==modelId||candidate.store!==model?.ifcDataStore||!candidate.review?.room||candidate.receipt)throw new Error('Unknown or consumed native Room candidate for this host/model.');
  candidate.review.validate();const {captureRoomGrounding}=await import('@/lib/actions/room-review');candidate.review.validate();return captureRoomGrounding(candidate.review.room);
}
