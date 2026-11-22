/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Flow panel's review checkpoint (#6923): what a paused run is waiting
 * for, and the transitions the reviewer drives.
 *
 *   pause    a run returned `review`: save a `prepared` checkpoint, show it
 *   approve  name the proposal digest the reviewer saw → `reviewed`
 *   claim    before a resume runs: `applying`, owned by this tab, after the
 *            graph, Player inputs and model state are re-checked
 *   finish   after the resume: `completed`, or `partially-committed`
 *   reject   → `rejected`; nothing downstream ever runs
 *
 * The model state a resume must start from is the loaded models' content
 * hashes plus every pending (undoable) mutation, taken after the paused run
 * committed its own writes: any later edit, undo or model change refuses the
 * resume and asks for a new run. Reloading the same files with no pending
 * edits is the same state, so a proposal that wrote nothing before its pause
 * can be approved after a reload. A tab that dies mid-resume
 * leaves `applying` behind. Recovery restores approval for an unstarted
 * reservation and marks a started resume partially committed.
 */

import { create } from 'zustand';
import { restoreRootBudget } from '@ifc-lite/ai';
import { AI_FEATURE } from '@ifc-lite/flow-nodes/ai';
import { digest, type FlowDocument, type RunResult } from '@ifc-lite/flow';
import {
  approveCheckpoint, CheckpointError, claimCheckpoint, createCheckpoint, finishCheckpoint, graphDigest,
  recoverCheckpoint, rejectCheckpoint, releaseCheckpoint, startCheckpoint, updateCheckpoint, type FlowCheckpoint
} from '@ifc-lite/flow/checkpoint';
import { useViewerStore } from '@/store';
import { flowRegistry } from './runner';
import { browserCheckpointStore, checkpointsOfGraph } from './checkpoint-store';

/** How long one tab may hold a claimed checkpoint before recovery treats it as abandoned. */
export const REVIEW_LEASE_MS = 10 * 60_000;
const TAB_OWNER = `tab:${crypto.randomUUID()}`;

export type ReviewProblem =
  | { readonly kind: 'refused'; readonly code: CheckpointError['code'] | 'budget-missing'; readonly message: string }
  | { readonly kind: 'not-saved'; readonly message: string };

export interface FlowReviewState {
  /** The open graph's latest checkpoint, or null. */
  checkpoint: FlowCheckpoint | null;
  /**
   * The Player values the paused run used, kept in this tab only (they may
   * hold files): a resume runs with them, so its inputs digest matches.
   * After a reload the resume uses no Player values, and a run that had
   * some is refused as changed rather than resumed with different inputs.
   */
  values: Record<string, unknown>;
  /** Prepared execution inputs, retained with this tab's paused run. */
  executionInputs?: Readonly<Record<string, unknown>>;
  busy: boolean;
  problem: ReviewProblem | null;
}

export const useFlowReview = create<FlowReviewState>(() => ({ checkpoint: null, values: {}, busy: false, problem: null }));

class BudgetReceiptError extends Error {}

function problemOf(error: unknown): ReviewProblem {
  if (error instanceof BudgetReceiptError) return { kind: 'refused', code: 'budget-missing', message: error.message };
  if (error instanceof CheckpointError) return { kind: 'refused', code: error.code, message: error.message };
  return { kind: 'not-saved', message: error instanceof Error ? error.message : String(error) };
}

/** Digest of the model state a run read and left behind: content hashes plus pending mutations. */
export function viewerSourceDigest(): string {
  const state = useViewerStore.getState();
  // Content, not session ids: the same file reloaded is the same source; a model without a content hash only matches itself.
  const models = [...state.models].map(([id, model]) => model.sourceContentHash ?? `model:${id}`).sort();
  const mutations = [...state.undoStacks.values()].flat().map((mutation) => mutation.id).sort();
  const active = state.activeModelId
    ? state.models.get(state.activeModelId)?.sourceContentHash ?? `model:${state.activeModelId}`
    : null;
  // Identical files may be loaded twice; their active occurrence is still a different source.
  const sameSource = [...state.models].filter(([id, model]) => (model.sourceContentHash ?? `model:${id}`) === active);
  const activeOccurrence = sameSource.findIndex(([id]) => id === state.activeModelId);
  return digest({ models, mutations, active, activeOccurrence, assistantModel: state.chatActiveModel });
}

/** Save a paused run's proposal as a `prepared` checkpoint and show it. Nothing downstream has run. */
export async function pauseForReview(input: {
  doc: FlowDocument; result: RunResult; inputs: Record<string, unknown>; values: Record<string, unknown>; budget?: unknown;
  canPublish?: () => boolean;
}): Promise<void> {
  const { values, canPublish = () => true, ...rest } = input;
  try {
    const checkpoint = createCheckpoint({ ...rest, registry: flowRegistry(), sourceDigest: viewerSourceDigest() });
    if (!(await browserCheckpointStore.write(checkpoint, null))) throw new Error('a checkpoint with this id already exists');
    if (canPublish()) useFlowReview.setState({ checkpoint, values, executionInputs: structuredClone(input.inputs), problem: null });
  } catch (error) {
    if (canPublish()) useFlowReview.setState({ checkpoint: null, problem: problemOf(error) });
  }
}

/** Load the graph's latest checkpoint after recovering any whose owner vanished mid-resume. */
export async function loadGraphReview(graphId: string): Promise<void> {
  const all = await checkpointsOfGraph(graphId);
  for (const checkpoint of all) {
    if (recoverCheckpoint(checkpoint)) await updateCheckpoint(browserCheckpointStore, checkpoint.id, (c) => recoverCheckpoint(c) ?? c);
  }
  const latest = (await checkpointsOfGraph(graphId))[0] ?? null;
  const current = useFlowReview.getState();
  const same = current.checkpoint?.id === latest?.id;
  useFlowReview.setState({ checkpoint: latest, values: same ? current.values : {}, executionInputs: same ? current.executionInputs : {}, problem: null });
}

async function transition(
  change: (checkpoint: FlowCheckpoint) => FlowCheckpoint,
  id = useFlowReview.getState().checkpoint?.id,
  retryStorage = false,
): Promise<FlowCheckpoint | null> {
  if (!id) return null;
  const visible = () => useFlowReview.getState().checkpoint?.id === id;
  const wasVisible = visible();
  if (wasVisible) useFlowReview.setState({ busy: true, problem: null });
  const publish = (patch: Partial<FlowReviewState>) => {
    if (visible()) useFlowReview.setState({ ...patch, busy: false });
    else if (wasVisible) useFlowReview.setState({ busy: false });
  };
  const update = () => updateCheckpoint(browserCheckpointStore, id, change);
  try {
    const next = await update().catch((error: unknown) => {
      // A storage failure can be transient. Repeat the checkpoint CAS only.
      if (!retryStorage || error instanceof CheckpointError) throw error;
      return update();
    });
    publish({ checkpoint: next });
    return next;
  } catch (error) {
    publish({ problem: problemOf(error) });
    return null;
  }
}

/** Approve the proposal the reviewer saw, named by its digest. */
export function approveReview(shownDigest: string, doc: FlowDocument): Promise<FlowCheckpoint | null> {
  return transition((c) => {
    if (c.graphDigest !== graphDigest(doc, useFlowReview.getState().executionInputs ?? {}, flowRegistry())) {
      throw new CheckpointError('graph-changed', 'The graph or Player inputs changed. Run the graph again.');
    }
    if (c.sourceDigest !== viewerSourceDigest()) throw new CheckpointError('sources-changed', 'The loaded sources changed. Run the graph again.');
    return approveCheckpoint(c, shownDigest);
  });
}

export function rejectReview(): Promise<FlowCheckpoint | null> {
  return transition((c) => rejectCheckpoint(c));
}

/** Claim the approved checkpoint for this tab's resume, against the graph and inputs it will run with. */
export function claimReview(doc: FlowDocument, inputs: Record<string, unknown>, checkpointId: string, deferStart = false): Promise<FlowCheckpoint | null> {
  return transition((c) => {
    const registry = flowRegistry();
    const aiAhead = doc.nodes.some(node => !Object.hasOwn(c.outputs, node.id) && registry.get(node.type)?.requires?.backend?.includes(AI_FEATURE));
    if (aiAhead && !restoreRootBudget(c.budget)) throw new BudgetReceiptError('Resuming downstream AI nodes requires the original root budget receipt. Run the graph again.');
    return claimCheckpoint(c, { owner: TAB_OWNER, graphDigest: graphDigest(doc, inputs, registry), sourceDigest: viewerSourceDigest(), leaseMs: REVIEW_LEASE_MS, deferStart });
  }, checkpointId);
}

export function startReviewClaim(reserved: FlowCheckpoint): Promise<FlowCheckpoint | null> {
  return transition((current) => startCheckpoint(current, reserved), reserved.id);
}

/** Return this tab's exact claim to review before any downstream work has started. */
export async function releaseReviewClaim(reserved: FlowCheckpoint): Promise<void> {
  const released = await updateCheckpoint(browserCheckpointStore, reserved.id, current => releaseCheckpoint(current, reserved));
  if (useFlowReview.getState().checkpoint?.id === reserved.id) useFlowReview.setState({ checkpoint: released });
}

export function finishReview(result: RunResult | null, failure: string | undefined, claimed: FlowCheckpoint): Promise<FlowCheckpoint | null> {
  const message = failure ?? result?.log.find((l) => l.level === 'error')?.message;
  return transition((c) => {
    if (!c.claim || c.claim.at !== claimed.claim?.at || c.claim.leaseUntil !== claimed.claim?.leaseUntil) {
      throw new CheckpointError('not-owner', 'The review claim is no longer held by this run.');
    }
    return finishCheckpoint(c, TAB_OWNER, { ok: !!result?.ok && failure === undefined, ...(message ? { message } : {}) });
  }, claimed.id, true);
}
