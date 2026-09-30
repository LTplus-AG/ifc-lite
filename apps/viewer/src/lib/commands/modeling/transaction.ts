/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runTransaction`: a modeling command's commit as ONE atomic undo step
 * (charter #6232, WP2).
 *
 *   1. the shared mutation gate (edit mode, collab role, editable model);
 *   2. snapshot every model's undo-stack length;
 *   3. `cmd.commit` inside try, then the per-kind type and layer-set
 *      defaults on what it built (`authored-defaults.ts`);
 *   4. tag everything pushed since the snapshot with one batch id, so one
 *      Ctrl+Z reverts the whole commit however many mutations it wrote;
 *   5. re-mesh the touched entities through the wasm re-mesh service and
 *      remember the batch, so undo / redo re-mesh it too (WP1);
 *   6. apply the command's selection.
 *
 * A commit that throws is reversed: its partial mutations are undone as one
 * batch, the redo branch that undo produced is dropped and any overlay entity
 * the commit created is removed, so the undo stack, the redo stack and the
 * session model's overlay are what they were before.
 */

import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { toGlobalIdFromModels } from '@/store/globalId';
import { mutationsSince, newMutationBatchId, undoStackLengths } from '@/store/slices/mutation-batch-tags';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import type { RemeshCause } from '@/lib/remesh/affected-set';
import { applyAuthoredDefaults } from './authored-defaults.js';
import type { AuthoringTransaction, CommandContext, CommitResult, ModelingCommand } from './types.js';

export interface RemeshRequest {
  readonly modelId: string;
  readonly batchId: string;
  readonly expressIds: readonly number[];
  readonly cause: RemeshCause;
}

export type RequestRemesh = (get: () => ViewerState, request: RemeshRequest) => void;

/** The wasm re-mesh service (#6297): re-mesh now, and again on undo / redo of the batch. */
const remeshService: RequestRemesh = (get, { modelId, batchId, expressIds, cause }) =>
  remeshAfterCommit(get, modelId, batchId, expressIds, cause);
let requestRemesh: RequestRemesh = remeshService;

/** Replace the re-mesh handler (tests). Returns the function that restores the previous one. */
export function setRequestRemesh(handler: RequestRemesh): () => void {
  const previous = requestRemesh;
  requestRemesh = handler;
  return () => { requestRemesh = previous; };
}

/** The store surface a transaction needs: read, and write back the redo branch on rollback. */
export type TransactionStore = Pick<StoreApi<ViewerState>, 'getState' | 'setState' | 'subscribe'>;

export type TransactionOutcome =
  | { ok: true; batchId: string | null; result: CommitResult }
  | { ok: false; reason: string };

export function runTransaction(
  store: TransactionStore,
  cmd: ModelingCommand,
  g: unknown,
  ctx: CommandContext,
): TransactionOutcome {
  const { modelId, storeyId, workplane } = ctx;
  const get = store.getState;
  const denial = mutationDenial(get(), modelId);
  if (denial) return { ok: false, reason: denial };

  const before = undoStackLengths(get().undoStacks);
  const redoBefore = get().redoStacks;
  const overlayBefore = overlayEntityIds(get());
  const batchId = newMutationBatchId();
  const tx: AuthoringTransaction = { modelId, storeyId, workplane, batchId, get store() { return get(); }, api: store };
  let result: CommitResult;
  try {
    result = cmd.commit(g, tx);
    applyAuthoredDefaults(store, result.modelId ?? modelId, result.authored ?? []);
  } catch (error) {
    rollBack(store, before, redoBefore);
    dropOverlayEntitiesSince(get(), overlayBefore);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[modeling] ${cmd.id} commit failed; reverted`, error);
    return { ok: false, reason };
  }

  const ids = mutationsSince(get().undoStacks, before);
  if (ids.length > 0) get().tagMutationBatch(ids, batchId);
  const target = result.modelId ?? modelId;
  if (ids.length > 0 && result.remesh.length > 0) {
    requestRemesh(get, { modelId: target, batchId, expressIds: result.remesh, cause: result.remeshCause ?? (result.created.length > 0 ? 'created' : 'shape') });
  }
  applySelection(get, target, result.select);
  return { ok: true, batchId: ids.length > 0 ? batchId : null, result };
}

/** Undo what a failed commit already wrote, then forget that undo's redo entries. */
function rollBack(
  store: TransactionStore,
  before: ReadonlyMap<string, number>,
  redoBefore: ViewerState['redoStacks'],
): void {
  const get = store.getState;
  const stacks = get().undoStacks;
  const touched = [...stacks].filter(([modelId, stack]) => stack.length > (before.get(modelId) ?? 0));
  for (const [modelId] of touched) {
    const ids = mutationsSince(new Map([[modelId, get().undoStacks.get(modelId) ?? []]]), before);
    get().tagMutationBatch(ids, newMutationBatchId());
    get().undo(modelId);
  }
  if (touched.length === 0) return;
  store.setState((s) => {
    const redoStacks = new Map(s.redoStacks);
    for (const [modelId] of touched) {
      const previous = redoBefore.get(modelId);
      if (previous) redoStacks.set(modelId, previous);
      else redoStacks.delete(modelId);
    }
    return { redoStacks };
  });
}

function overlayEntityIds(state: ViewerState): Map<string, Set<number>> {
  const ids = new Map<string, Set<number>>();
  for (const [modelId, view] of state.mutationViews) ids.set(modelId, new Set(view.getNewEntities().map((e) => e.expressId)));
  return ids;
}

/**
 * A builder writes one CREATE_ENTITY record for the element but also creates
 * its placement, profile and representation entities without history of
 * their own; undoing the element leaves those unreferenced helpers behind.
 * A rolled-back commit must leave every model's overlay as it found it (a
 * command may write to another model than the session's), so drop them.
 */
function dropOverlayEntitiesSince(state: ViewerState, before: ReadonlyMap<string, ReadonlySet<number>>): void {
  for (const [modelId, view] of state.mutationViews) {
    const kept = before.get(modelId) ?? new Set<number>();
    for (const { expressId } of view.getNewEntities()) if (!kept.has(expressId)) view.deleteEntity(expressId);
  }
}

function applySelection(get: () => ViewerState, modelId: string, select: readonly number[] | undefined): void {
  if (!select || select.length === 0) return;
  const state = get();
  const globalIds = select.map((id) => toGlobalIdFromModels(state.models, modelId, id));
  if (globalIds.length === 1) state.setSelectedEntityId(globalIds[0]);
  else state.setSelectedEntityIds(globalIds);
}
