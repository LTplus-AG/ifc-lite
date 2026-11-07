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
 * - Escape reverts it, and the redo history is put back as it was. When
 *   another write (a script, another tool) has landed on top of the preview,
 *   undoing it would undo that write too, so Escape instead applies the edit
 *   that puts the level back, as one more undo step. The history then shows
 *   what happened: the re-level, the other write, and the cancel (one step,
 *   however many storeys it puts back).
 *   Undoing that cancel brings the re-level back, as undoing any step does.
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
  /**
   * What puts the levels back for a preview another write has buried: each
   * storey the preview moved, at its elevation before. Absolute elevations,
   * so a storey added or moved meanwhile cannot skew the restore.
   */
  readonly inverse: readonly StoreyLevelEdit[];
}

let active: ActivePreview | null = null;

export interface StoreyPreview {
  /** The plan the preview applied (or would apply): what the impact summary shows. */
  readonly plan: StoreyLevelPlan | null;
  /** Whether the model shows the edit right now. */
  readonly applied: boolean;
  readonly outcome: StoreyOpOutcome | null;
}

/**
 * Replace the running preview with `edit`. A refused plan reverts and applies
 * nothing. If the running preview cannot be put back first (another write
 * buried it and its restore is refused), nothing new is applied either: the
 * refusal is returned as `outcome`, so the field says the old edit stands.
 */
export function previewStoreyLevel(store: TransactionStore, modelId: string, edit: StoreyLevelEdit): StoreyPreview {
  const refused = revertStoreyPreview(store);
  if (refused && !refused.ok) return { plan: null, applied: false, outcome: refused };
  const target = modelEditTarget(store.getState(), modelId);
  const plan = target ? planStoreyLevelEdit(readStoreyInventory(target.dataStore, target.view), edit) : null;
  if (!plan || plan.refusals.length > 0 || plan.storeys.length === 0 || store.getState().collabSession) {
    return { plan, applied: false, outcome: null };
  }
  const redoBefore = store.getState().redoStacks.get(modelId);
  const inverse = inverseOf(plan);
  const outcome = commitStoreyOp(store, modelId, { kind: 'level', edit });
  if (outcome.ok && outcome.batchId) active = { modelId, batchId: outcome.batchId, redoBefore, inverse };
  return { plan, applied: outcome.ok, outcome };
}

/**
 * Keep the running preview as the committed edit. False when there is none,
 * or when it is no longer the latest edit (a script undid it, or wrote over
 * it): the caller then applies the typed edit itself, so Enter always leaves
 * the model at the value in the field.
 */
export function keepStoreyPreview(store: TransactionStore): boolean {
  if (!active) return false;
  const { modelId, batchId } = active;
  active = null;
  const state = store.getState();
  const top = state.undoStacks.get(modelId)?.at(-1);
  return !!top && state.mutationBatchTags.get(top.id) === batchId;
}

/**
 * Undo the running preview and restore the redo history. A preview another
 * write has buried is restored storey by storey instead; if that is refused
 * (a storey added meanwhile sits in the way), the refusal is returned so
 * Escape can say the edit is still applied. Null when nothing was refused.
 */
export function revertStoreyPreview(store: TransactionStore): StoreyOpOutcome | null {
  if (!active) return null;
  const { modelId, batchId, redoBefore, inverse } = active;
  active = null;
  const state = store.getState();
  const top = state.undoStacks.get(modelId)?.at(-1);
  if (!top || state.mutationBatchTags.get(top.id) !== batchId) {
    // Something else (a script, another tool) was written on top of the preview, so undoing
    // would undo that instead. Cancel still means the level goes back: re-level it as it was.
    // All or nothing: if one storey cannot go back, the ones already restored are undone
    // again (each is the newest step), so the preview is left whole rather than half-cancelled.
    const redoBeforeRestore = state.redoStacks.get(modelId);
    const restoredBatches: string[] = [];
    for (const edit of inverse) {
      const restored = commitStoreyOp(store, modelId, { kind: 'level', edit });
      if (!restored.ok) {
        for (let i = restoredBatches.length; i > 0; i--) store.getState().undo(modelId);
        setRedo(store, modelId, redoBeforeRestore);
        return restored;
      }
      if (restored.batchId) restoredBatches.push(restored.batchId);
    }
    joinBatches(store, modelId, restoredBatches);
    return null;
  }
  state.undo(modelId);
  setRedo(store, modelId, redoBefore);
  return null;
}

/** One cancel is one Undo step: the restores' records join the first restore's batch. */
function joinBatches(store: TransactionStore, modelId: string, batches: readonly string[]): void {
  if (batches.length < 2) return;
  const state = store.getState();
  const joined = new Set(batches);
  const ids = (state.undoStacks.get(modelId) ?? [])
    .filter((record) => joined.has(state.mutationBatchTags.get(record.id) ?? ''))
    .map((record) => record.id);
  state.tagMutationBatch(ids, batches[0]);
}

function setRedo(store: TransactionStore, modelId: string, stack: RedoStack): void {
  store.setState((s) => {
    const redoStacks = new Map(s.redoStacks);
    if (stack) redoStacks.set(modelId, stack);
    else redoStacks.delete(modelId);
    return { redoStacks };
  });
}

export function hasStoreyPreview(): boolean {
  return active !== null;
}

/**
 * The edits that put back every storey `plan` moves, one elevation each, in
 * an order that never passes a neighbour: storeys returning down go lowest
 * first, storeys returning up go highest first.
 */
function inverseOf(plan: StoreyLevelPlan): StoreyLevelEdit[] {
  const down = plan.storeys.filter((move) => move.to > move.from).sort((a, b) => a.to - b.to);
  const up = plan.storeys.filter((move) => move.to < move.from).sort((a, b) => b.to - a.to);
  return [...down, ...up].map((move) => ({ kind: 'elevation', storeyId: move.expressId, Elevation: move.from }));
}
