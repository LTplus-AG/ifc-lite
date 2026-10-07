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
 * leaves `applying` behind; once its lease runs out the next load marks it
 * partially committed, never claimable again.
 */

import { create } from 'zustand';
import { digest, type FlowDocument, type RunResult } from '@ifc-lite/flow';
import {
  approveCheckpoint, CheckpointError, claimCheckpoint, createCheckpoint, finishCheckpoint, graphDigest,
  recoverCheckpoint, rejectCheckpoint, updateCheckpoint, type FlowCheckpoint
} from '@ifc-lite/flow/checkpoint';
import { useViewerStore } from '@/store';
import { browserCheckpointStore, checkpointsOfGraph } from './checkpoint-store';

/** How long one tab may hold a claimed checkpoint before recovery treats it as abandoned. */
export const REVIEW_LEASE_MS = 10 * 60_000;
const TAB_OWNER = `tab:${crypto.randomUUID()}`;

export type ReviewProblem =
  | { readonly kind: 'refused'; readonly code: CheckpointError['code']; readonly message: string }
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
  busy: boolean;
  problem: ReviewProblem | null;
}

export const useFlowReview = create<FlowReviewState>(() => ({ checkpoint: null, values: {}, busy: false, problem: null }));

function problemOf(error: unknown): ReviewProblem {
  if (error instanceof CheckpointError) return { kind: 'refused', code: error.code, message: error.message };
  return { kind: 'not-saved', message: error instanceof Error ? error.message : String(error) };
}

/** Digest of the model state a run read and left behind: content hashes plus pending mutations. */
export function viewerSourceDigest(): string {
  const state = useViewerStore.getState();
  // Content, not session ids: the same file reloaded is the same source; a model without a content hash only matches itself.
  const models = [...state.models].map(([id, model]) => model.sourceContentHash ?? `model:${id}`).sort();
  const mutations = [...state.undoStacks.values()].flat().map((mutation) => mutation.id).sort();
  return digest({ models, mutations });
}

/** Save a paused run's proposal as a `prepared` checkpoint and show it. Nothing downstream has run. */
export async function pauseForReview(input: {
  doc: FlowDocument; result: RunResult; inputs: Record<string, unknown>; values: Record<string, unknown>; budget?: unknown;
}): Promise<void> {
  try {
    const { values, ...rest } = input;
    const checkpoint = createCheckpoint({ ...rest, sourceDigest: viewerSourceDigest() });
    if (!(await browserCheckpointStore.write(checkpoint, null))) throw new Error('a checkpoint with this id already exists');
    useFlowReview.setState({ checkpoint, values, problem: null });
  } catch (error) {
    useFlowReview.setState({ checkpoint: null, problem: problemOf(error) });
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
  useFlowReview.setState({ checkpoint: latest, values: current.checkpoint?.id === latest?.id ? current.values : {}, problem: null });
}

async function transition(change: (checkpoint: FlowCheckpoint) => FlowCheckpoint): Promise<FlowCheckpoint | null> {
  const current = useFlowReview.getState().checkpoint;
  if (!current) return null;
  useFlowReview.setState({ busy: true, problem: null });
  try {
    const next = await updateCheckpoint(browserCheckpointStore, current.id, change);
    useFlowReview.setState({ checkpoint: next, busy: false });
    return next;
  } catch (error) {
    useFlowReview.setState({ busy: false, problem: problemOf(error) });
    return null;
  }
}

/** Approve the proposal the reviewer saw, named by its digest. */
export function approveReview(shownDigest: string): Promise<FlowCheckpoint | null> {
  return transition((c) => approveCheckpoint(c, shownDigest));
}

export function rejectReview(): Promise<FlowCheckpoint | null> {
  return transition((c) => rejectCheckpoint(c));
}

/** Claim the approved checkpoint for this tab's resume, against the graph and inputs it will run with. */
export function claimReview(doc: FlowDocument, inputs: Record<string, unknown>): Promise<FlowCheckpoint | null> {
  return transition((c) => claimCheckpoint(c, { owner: TAB_OWNER, graphDigest: graphDigest(doc, inputs), sourceDigest: viewerSourceDigest(), leaseMs: REVIEW_LEASE_MS }));
}

export function finishReview(result: RunResult | null, failure?: string): Promise<FlowCheckpoint | null> {
  const message = failure ?? result?.log.find((l) => l.level === 'error')?.message;
  return transition((c) => finishCheckpoint(c, TAB_OWNER, { ok: !!result?.ok && failure === undefined, ...(message ? { message } : {}) }));
}
