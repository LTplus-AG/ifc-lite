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

const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const tokenInput = { type: 'object' as const, properties: { token: { type: 'string' as const, minLength: 1, maxLength: 100 } }, required: ['token' as const], additionalProperties: false as const };
const previewOutput = { type: 'object', properties: { token: { type: 'string' }, preview_json: { type: 'string' } }, required: ['token', 'preview_json'], additionalProperties: false };
const meta = (id: string, owner: string, description: string, write = false) => ({ id, owner, description,
  effects: write ? ['model'] as const : ['read'] as const, capability: write ? 'commands-and-edits' as const : 'read' as const,
  implementation: 'native-store' as const, policy: write ? { model: 'native-reviewed' as const } : undefined, outputSchema: jsonOutput });
interface Review { room?: import('@/lib/actions/room-review').RoomReview; preview: object; validate(): void; commit(): ModelChangeReceipt; dispose?(): void }
interface Candidate { store: OperationContext['model']['store']; modelId: string; review?: Review; receipt?: ModelChangeReceipt }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: Pick<OperationContext, 'host'>) {
  let entries = hosts.get(c.host);
  if (!entries) {
    entries = new Map(); hosts.set(c.host, entries);
    const captured = entries;
    c.host.lifetimeSignal?.addEventListener('abort', () => { for (const candidate of captured.values()) candidate.review?.dispose?.(); captured.clear(); }, { once: true });
  }
  return entries;
}
/** Drop one candidate and release its native handles. */
function release(entries: Map<string, Candidate>, token: string) { entries.get(token)?.review?.dispose?.(); entries.delete(token); }
const output = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
function proposalModel(value: { modelId: string }, c: OperationContext) { if (value.modelId !== c.model.id) throw new Error('The proposal must name the selected model.'); }
async function prepare(kind: 'group' | 'structural' | 'zone' | 'room', json: string, c: OperationContext): Promise<Review> {
  switch (kind) {
    case 'group': {
      const [{ parseGroupProposal }, { prepareGroupReview }, { commitReviewedGroup }] = await Promise.all([import('@/lib/actions/group-lifecycle-proposal'), import('@/lib/actions/group-lifecycle-review'), import('@/lib/actions/group-lifecycle-receipt')]);
      const proposal = parseGroupProposal(json); proposalModel(proposal, c);
      const review = prepareGroupReview(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, delta: review.delta }, validate: review.validate,
        commit: () => commitReviewedGroup(useViewerStore, review, 'viewer-agent') };
    }
    case 'structural': {
      const [{ parseStructuralProposal }, { prepareStructuralReview }, { commitReviewedStructural }] = await Promise.all([import('@/lib/actions/structural-graph-proposal'), import('@/lib/actions/structural-graph-review'), import('@/lib/actions/structural-graph-receipt')]);
      const proposal = parseStructuralProposal(json); proposalModel(proposal, c);
      const review = prepareStructuralReview(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, delta: review.delta }, validate: review.validate,
        commit: () => commitReviewedStructural(useViewerStore, review, 'viewer-agent') };
    }
    case 'zone': {
      const [{ parseZoneEmissionProposal }, { prepareZoneEmission }] = await Promise.all([import('@/lib/actions/zone-emission-proposal'), import('@/lib/actions/zone-emission-review')]);
      const proposal = parseZoneEmissionProposal(json); proposalModel(proposal, c);
      const review = prepareZoneEmission(useViewerStore, proposal);
      return { preview: { proposal: review.proposal, snapshot: review.snapshot, dry: review.dry }, validate: review.validate, commit: () => review.commit('viewer-agent') };
    }
    case 'room': {
      const [{ parseRoomProposal }, { prepareRoomReview }, { commitReviewedRoom }] = await Promise.all([import('@/lib/actions/room-command-proposal'), import('@/lib/actions/room-review'), import('@/lib/actions/room-receipt')]);
      const proposal = parseRoomProposal(json); proposalModel(proposal, c);
      // The native preparation remeshes the storey walls first; that is this operation's own write, and the review's
      // geometry lease, checked by validate() below, binds the geometry it read.
      const review = await c.ownGeometry(() => prepareRoomReview(proposal, c.signal ?? new AbortController().signal), refused => refused.dispose());
      return { room: review, preview: { proposal: review.proposal, snapshot: review.snapshot, result: review.prepared.result }, validate: review.validate,
        commit: () => commitReviewedRoom(review, 'viewer-agent').receipt, dispose: review.dispose };
    }
  }
}
export const graphAuthoringOperations = [
  operation({ ...meta('authoring.graphs.describe', 'model', 'Describe canonical reviewed generic Group memberships, Structural graphs, evaluated zone emission and Room command proposals.'), outputSchema: jsonOutput }, emptySchema, async () => {
    const [groups, structural, zones, rooms] = await Promise.all([import('@/lib/actions/group-lifecycle-proposal'), import('@/lib/actions/structural-graph-proposal'), import('@/lib/actions/zone-emission-proposal'), import('@/lib/actions/room-command-proposal')]);
    return output({ group: groups.GROUP_LIFECYCLE_GUIDANCE, structural: structural.STRUCTURAL_GRAPH_GUIDANCE, zone: zones.ZONE_EMISSION_GUIDANCE, room: `${rooms.ROOM_COMMAND_GUIDANCE} Through viewer operations, authoring.room.prepare remeshes the storey walls first, so it runs through viewer_operation_execute with the edit grant; only authoring.graph.apply creates the rooms.` });
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
  ...(['group', 'structural', 'zone', 'room'] as const).map(kind => operation<{ proposal_json: string }>({ ...meta(`authoring.${kind}.prepare`, kind === 'zone' ? 'zones' : 'model', `Prepare the canonical ${kind} proposal using its native detached planner and complete evidence. Room supports pick/auto/autoAll/footprint/update/edit; no invented pointer gestures.${kind === 'room' ? ' Room preparation remeshes the storey walls first, so it runs through viewer_operation_execute with the edit grant, in the foreground.' : ''}`), outputSchema: previewOutput,
    // A Room preparation remeshes the storey walls first, which replaces the model's geometry in the scene: a view write
    // that needs the edit grant and cannot run through viewer_operation_inspect.
    ...(kind === 'room' ? { effects: ['view'] as const, capability: 'commands-and-edits' as const } : {}),
    // A result the executor refuses never reaches the caller, so its candidate must not keep a place under the cap.
    discard: (result, c) => {
      const token = (result as { token?: unknown } | null)?.token, entries = hosts.get(c.host);
      if (entries && typeof token === 'string' && entries.get(token)?.receipt === undefined) release(entries, token);
    } }, {
    type: 'object', properties: { proposal_json: { type: 'string', maxLength: 1000000 } }, required: ['proposal_json'], additionalProperties: false,
  }, async (i, c) => {
    if (owned(c).size >= 32) throw new Error('At most 32 graph review candidates may be retained.');
    const review = await prepare(kind, i.proposal_json, c);
    let preview_json: string;
    try { assertToolActive(c); review.validate(); preview_json = JSON.stringify(review.preview); } catch (error) { review.dispose?.(); throw error; }
    const token = crypto.randomUUID(); owned(c).set(token, { modelId: c.model.id, store: c.model.store, review });
    return { token, preview_json };
  })),
  operation<{ token: string }>(meta('authoring.graph.apply', 'model', 'Apply one exact prepared native graph/Room candidate through its native synchronous review commit. Preserves all native roles, source/evidence checks and native undo. A token applies once.', true), tokenInput, async (i, c) => {
    const entry = owned(c).get(i.token);
    if (!entry || entry.modelId !== c.model.id || entry.store !== c.model.store) throw new Error('Unknown graph review for this host/model.');
    if (!entry.receipt) {
      const review = entry.review!;
      entry.receipt = c.commit(() => { review.validate(); return review.commit(); });
      review.dispose?.(); entry.review = undefined;
    }
    const { modelChangeLibrary } = await import('@/lib/actions/receipts');
    const persisted = await modelChangeLibrary.put(entry.receipt.id, entry.receipt); return output({ receipt: entry.receipt, persisted });
  }),
  operation<{ token: string }>(meta('authoring.graph.discard', 'model', 'Dispose a native graph or Room preview and release its native handles.'), tokenInput, (i, c) => {
    const entry = owned(c).get(i.token);
    if (!entry || entry.modelId !== c.model.id || entry.store !== c.model.store) throw new Error('Unknown graph review.');
    release(owned(c), i.token); return output({ discarded: true });
  }),
];

/** Capture only the actual live prepared RoomReview owned by this host. */
export async function captureRoomGroundingForCandidate(host:ToolHost,token:string,modelId:string){
  const candidate=hosts.get(host)?.get(token),model=useViewerStore.getState().models.get(modelId);
  if(!candidate||candidate.modelId!==modelId||candidate.store!==model?.ifcDataStore||!candidate.review?.room||candidate.receipt)throw new Error('Unknown or consumed native Room candidate for this host/model.');
  candidate.review.validate();const {captureRoomGrounding}=await import('@/lib/actions/room-review');candidate.review.validate();return captureRoomGrounding(candidate.review.room);
}
