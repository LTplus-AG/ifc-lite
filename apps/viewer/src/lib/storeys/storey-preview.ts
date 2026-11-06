/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live preview of a storey re-level (#9013). While a storey's elevation or
 * floor-to-floor height is being typed, the edit is applied for real as a
 * provisional transaction, so 3D and the plan show true geometry (walls
 * re-meshed at their new height, stairs refit) rather than an approximation.
 *
 * - every change of the typed value first reverts the previous preview, then
 *   plans against the unchanged model and applies the new value;
 * - Enter keeps the last preview: it already is the one undo step;
 * - Escape reverts it, and the redo history is put back as it was.
 *
 * In a shared room the provisional edits would reach the other participants,
 * so there the preview stops at the plan (impact summary only) and the edit
 * is applied on Enter.
 */

import { planStoreyLevelEdit, readStoreyInventory, type StoreyLevelEdit, type StoreyLevelPlan } from '@ifc-lite/create';
import type { TransactionStore } from '@/lib/commands/modeling/transaction';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commitStoreyOp, type StoreyOpOutcome } from '@/store/slices/mutation-storey';

type RedoStack = ReturnType<ViewerState['redoStacks']['get']>;

interface ActivePreview {
  readonly modelId: string;
  readonly batchId: string;
  readonly redoBefore: RedoStack;
}

let active: ActivePreview | null = null;

export interface StoreyPreview {
  /** The plan the preview applied (or would apply): what the impact summary shows. */
  readonly plan: StoreyLevelPlan | null;
  /** Whether the model shows the edit right now. */
  readonly applied: boolean;
  readonly outcome: StoreyOpOutcome | null;
}

/** Plan an edit against the model as it is without any running preview. */
export function planStoreyPreview(store: TransactionStore, modelId: string, edit: StoreyLevelEdit): StoreyLevelPlan | null {
  revertStoreyPreview(store);
  const target = modelEditTarget(store.getState(), modelId);
  return target ? planStoreyLevelEdit(readStoreyInventory(target.dataStore, target.view), edit) : null;
}

/** Replace the running preview with `edit`. A refused plan reverts and applies nothing. */
export function previewStoreyLevel(store: TransactionStore, modelId: string, edit: StoreyLevelEdit): StoreyPreview {
  const plan = planStoreyPreview(store, modelId, edit);
  if (!plan || plan.refusals.length > 0 || plan.storeys.length === 0 || store.getState().collabSession) {
    return { plan, applied: false, outcome: null };
  }
  const redoBefore = store.getState().redoStacks.get(modelId);
  const outcome = commitStoreyOp(store, modelId, { kind: 'level', edit });
  if (outcome.ok && outcome.batchId) active = { modelId, batchId: outcome.batchId, redoBefore };
  return { plan, applied: outcome.ok, outcome };
}

/** Keep the running preview as the committed edit. */
export function keepStoreyPreview(): boolean {
  const kept = active !== null;
  active = null;
  return kept;
}

/** Undo the running preview, if it is still the latest step, and restore the redo history. */
export function revertStoreyPreview(store: TransactionStore): void {
  if (!active) return;
  const { modelId, batchId, redoBefore } = active;
  active = null;
  const state = store.getState();
  const top = state.undoStacks.get(modelId)?.at(-1);
  // Something else was written on top of the preview: it is no longer ours to undo.
  if (!top || state.mutationBatchTags.get(top.id) !== batchId) return;
  state.undo(modelId);
  store.setState((s) => {
    const redoStacks = new Map(s.redoStacks);
    if (redoBefore) redoStacks.set(modelId, redoBefore);
    else redoStacks.delete(modelId);
    return { redoStacks };
  });
}

export function hasStoreyPreview(): boolean {
  return active !== null;
}
