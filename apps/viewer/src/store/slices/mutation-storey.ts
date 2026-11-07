/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey writes in the viewer (#9013): the one write path behind the storey
 * manager and the `bim.store` storey methods, over `@ifc-lite/create`'s
 * plan/apply functions.
 *
 * Each op runs through `runTransaction`, so it is ONE undo step however many
 * placements, walls and stairs it wrote, and the wasm re-mesh seam rebuilds
 * every element whose world position or shape changed, now and on undo/redo.
 * Refusals are decided by the plan before the transaction starts, so a
 * refused op never reaches the undo stack.
 */

import {
  addStoreyInStore, applyStoreyDelete, applyStoreyLevelEdit, planStoreyDelete, planStoreyLevelEdit,
  readStoreyInventory, renameStoreyInStore, StoreyEditRefusedError,
  type AddStoreyParams, type StoreyDeleteMode, type StoreyDeletePlan, type StoreyLevelEdit, type StoreyLevelPlan, type StoreyRefusal,
} from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { runTransaction, type TransactionStore } from '@/lib/commands/modeling/transaction';
import type { ModelingCommand } from '@/lib/commands/modeling/types';
import type { ViewerState } from '../index.js';
import { modelEditTarget, recordModellingCommit } from './mutation-modelling-records.js';
import { completeEntityRemoval } from './mutation-mesh-stash.js';

export type StoreyOp =
  | { readonly kind: 'add'; readonly params: AddStoreyParams }
  | { readonly kind: 'rename'; readonly storeyId: number; readonly Name: string }
  /** `expected`: the reviewed plan; a model that changed since is refused with code `stale`. */
  | { readonly kind: 'level'; readonly edit: StoreyLevelEdit; readonly expected?: StoreyLevelPlan }
  | { readonly kind: 'delete'; readonly storeyId: number; readonly mode: StoreyDeleteMode; readonly expected?: StoreyDeletePlan };

export type StoreyOpOutcome =
  | { readonly ok: true; readonly batchId: string | null; readonly storeyId: number | null; readonly remeshed: readonly number[] }
  | { readonly ok: false; readonly reason: string; readonly refusals: readonly StoreyRefusal[] };

/** The plan-time refusals of an op, or an empty list. Reads only. */
export function storeyOpRefusals(state: ViewerState, modelId: string, op: StoreyOp): readonly StoreyRefusal[] {
  const target = modelEditTarget(state, modelId);
  if (!target) return [{ code: 'notFound', message: `No model loaded for id "${modelId}"` }];
  const inventory = readStoreyInventory(target.dataStore, target.view);
  if (op.kind === 'level') return planStoreyLevelEdit(inventory, op.edit).refusals;
  if (op.kind === 'delete') return planStoreyDelete(inventory, op.storeyId, op.mode).refusals;
  return [];
}

function refused(refusals: readonly StoreyRefusal[]): StoreyOpOutcome {
  return { ok: false, reason: refusals.map((r) => r.message).join('; '), refusals };
}

/** Apply one storey op as one undo step. */
export function commitStoreyOp(store: TransactionStore, modelId: string, op: StoreyOp): StoreyOpOutcome {
  const planned = storeyOpRefusals(store.getState(), modelId, op);
  if (planned.length) return refused(planned);
  let storeyId: number | null = null;
  let removed: number[] = [];
  let late: readonly StoreyRefusal[] | null = null;
  const command: ModelingCommand = {
    id: 'storey.edit',
    labelKey: 'storeyManager.undoLabel',
    hud: {},
    snap: 'modeling',
    init: () => null,
    pointerMove: (g) => g,
    pointerDown: (g) => g,
    commit: (_g, tx) => {
      try {
        const written = recordModellingCommit(tx.api, modelId, (editor, dataStore) => write(dataStore, editor, op), tx.batchId);
        storeyId = written.storeyId;
        removed = written.removed;
        return { created: [], deleted: written.removed, remesh: written.remesh, remeshCause: 'shape' };
      } catch (error) {
        if (error instanceof StoreyEditRefusedError) late = error.refusals;
        throw error;
      }
    },
  };
  const get = store.getState;
  const outcome = runTransaction(store, command, null, { get, modelId, storeyId: get().session?.storeyId ?? null, workplane: null });
  if (!outcome.ok) return late ? refused(late) : { ok: false, reason: outcome.reason, refusals: [] };
  for (const id of removed) {
    completeEntityRemoval(get, store.setState, modelId, id, get().removedNewEntities.get(`${modelId}:${id}`));
  }
  return { ok: true, batchId: outcome.batchId, storeyId, remeshed: outcome.result.remesh };
}

interface Written { storeyId: number | null; remesh: number[]; removed: number[] }

function write(dataStore: IfcDataStore, editor: StoreEditor, op: StoreyOp): Written {
  switch (op.kind) {
    case 'add': {
      const added = addStoreyInStore(dataStore, editor, op.params);
      return { storeyId: added.storeyId, remesh: [...added.reshaped], removed: [] };
    }
    case 'rename':
      renameStoreyInStore(dataStore, editor, op.storeyId, op.Name);
      return { storeyId: op.storeyId, remesh: [], removed: [] };
    case 'level': {
      const { plan, reshaped } = applyStoreyLevelEdit(dataStore, editor, op.edit, op.expected);
      return { storeyId: op.edit.storeyId, remesh: [...new Set([...plan.moved, ...reshaped])], removed: [] };
    }
    case 'delete': {
      const plan = applyStoreyDelete(dataStore, editor, op.storeyId, op.mode, op.expected);
      // Moved contents keep their world position, so nothing re-meshes.
      const removed = op.mode.kind === 'deleteContents' ? [...plan.contents, op.storeyId] : [op.storeyId];
      return { storeyId: null, remesh: [], removed };
    }
  }
}
