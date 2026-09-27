/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store';
import { hasAppearanceHistoryEntry } from '@/lib/appearance/history';
import { applyRedoToView, applyUndoToView } from '@/store/slices/mutation-history-apply';
import { georefPatch } from '@/store/slices/mutation-history-replay';
import { inverseMutationTargets, revertedMutationIds } from '@/store/slices/mutation-inverse-registry';
import { changeOperations, type ChangeOperation } from './change-operations.js';

export type RevertRefusal = 'stale' | 'edit-mode' | 'collab-role' | 'model-unavailable'
  | 'newer-conflict' | 'unsupported' | 'missing-view' | 'shared-room';
export type RevertResult = { ok: true; mode: 'undo' | 'inverse' } | { ok: false; reason: RevertRefusal };

const georef = (mutation: Mutation) => mutation.type === 'UPDATE_ATTRIBUTE'
  && mutation.attributeName?.startsWith('georef.') === true;
const lifecycle = (mutation: Mutation) => mutation.type === 'CREATE_ENTITY' || mutation.type === 'DELETE_ENTITY';
const setKind = (mutation: Mutation) => mutation.type.includes('QUANTITY') ? 'quantity' : 'property';

/** Two edits conflict only if one can overwrite the other's IFC slot. */
export function changesConflict(a: Mutation, b: Mutation): boolean {
  if (a.modelId !== b.modelId) return false;
  if (georef(a) || georef(b)) return georef(a) && georef(b) && a.attributeName === b.attributeName;
  if (a.entityId !== b.entityId) return false;
  if (lifecycle(a) || lifecycle(b)) return true;
  if (a.type === 'UPDATE_ENTITY_TYPE' || b.type === 'UPDATE_ENTITY_TYPE') {
    // A later edit can depend on the class's EXPRESS slot layout; never
    // retarget an older class while that edit remains active.
    return true;
  }
  if (a.type === 'UPDATE_ATTRIBUTE' || a.type === 'UPDATE_POSITIONAL_ATTRIBUTE'
    || b.type === 'UPDATE_ATTRIBUTE' || b.type === 'UPDATE_POSITIONAL_ATTRIBUTE') {
    return a.type === b.type && a.attributeName === b.attributeName;
  }
  if (a.psetName !== b.psetName || setKind(a) !== setKind(b)) return false;
  return !!a.setOverlay || !!b.setOverlay || a.propName === b.propName;
}

function replayable(mutation: Mutation): boolean {
  if (georef(mutation)) return true;
  if (mutation.setOverlay) return true;
  switch (mutation.type) {
    case 'CREATE_PROPERTY':
    case 'CREATE_QUANTITY':
    case 'UPDATE_ATTRIBUTE':
    case 'UPDATE_POSITIONAL_ATTRIBUTE':
    case 'UPDATE_ENTITY_TYPE':
    case 'CREATE_ENTITY':
    case 'DELETE_ENTITY': return true;
    case 'UPDATE_PROPERTY':
    case 'DELETE_PROPERTY': return mutation.oldValue !== undefined;
    case 'UPDATE_QUANTITY': return mutation.oldValue !== undefined && mutation.oldValue !== null;
    default: return false;
  }
}

function applyTarget(store: StoreApi<ViewerState>, mutation: Mutation, direction: 'undo' | 'redo'): void {
  if (georef(mutation)) {
    store.setState(state => georefPatch(state, mutation.modelId, mutation, direction));
    return;
  }
  const view = store.getState().mutationViews.get(mutation.modelId)!;
  if (direction === 'undo') applyUndoToView(store.getState, store.setState, mutation.modelId, view, mutation);
  else applyRedoToView(store.getState, store.setState, mutation.modelId, view, mutation);
}

/** Revert a live drawer row without overwriting any newer edit to its slots. */
export function revertChangeOperation(store: StoreApi<ViewerState>, requested: ChangeOperation): RevertResult {
  const state = store.getState();
  const live = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(store))
    .find(operation => operation.id === requested.id);
  if (!live || live.mutations.length !== requested.mutations.length
    || live.mutations.some((mutation, index) => mutation.id !== requested.mutations[index]?.id)) {
    return { ok: false, reason: 'stale' };
  }
  if (!state.editEnabled) return { ok: false, reason: 'edit-mode' };
  // The generic history replay writes the local overlay, but property and
  // quantity inverses do not mirror into the room CRDT. Never show a local-only
  // Revert as a successful shared edit (#5902).
  if (state.collabRoomId !== null) return { ok: false, reason: 'shared-room' };
  if (!state.canCollabEdit()) return { ok: false, reason: 'collab-role' };
  for (const modelId of live.modelIds) {
    const model = state.models.get(modelId);
    if (!(model?.ifcDataStore ?? (state.models.size === 0 ? state.ifcDataStore : null))) {
      return { ok: false, reason: 'model-unavailable' };
    }
    // Preflight every model before the first Undo. replayHistory refuses to
    // advance a non-georef stack without its view; a federated batch must
    // never return success after only its first model was reversed.
    if (live.mutations.some(mutation => mutation.modelId === modelId && !georef(mutation))
      && !state.mutationViews.get(modelId)) return { ok: false, reason: 'missing-view' };
  }
  if (live.isTop) {
    const ids = new Set(live.mutations.map(mutation => mutation.id));
    for (const modelId of live.modelIds) {
      const current = store.getState();
      if (ids.has(current.undoStacks.get(modelId)?.at(-1)?.id ?? '')) current.undo(modelId);
    }
    for (const id of ids) revertedMutationIds(store).add(id);
    // The viewer's Ctrl+Y addresses the active model. Keep the just-undone
    // operation reachable even when the drawer row belonged to another model.
    store.getState().setActiveModel(live.modelIds[0]);
    return { ok: true, mode: 'undo' };
  }

  // Appearance commands own GPU/asset lifetimes; their registered replay must
  // remain on top. All other history types use the shared per-mutation replay.
  if (live.mutations.some(mutation => !replayable(mutation) || hasAppearanceHistoryEntry(store, mutation.id))) {
    return { ok: false, reason: 'unsupported' };
  }
  const targets = new Set(live.mutations.map(mutation => mutation.id));
  for (const modelId of live.modelIds) {
    const stack = state.undoStacks.get(modelId) ?? [];
    for (let i = 0; i < stack.length; i++) {
      if (!targets.has(stack[i].id)) continue;
      if (stack.slice(i + 1).some(newer => !targets.has(newer.id)
        && live.mutations.some(target => changesConflict(target, newer)))) {
        return { ok: false, reason: 'newer-conflict' };
      }
    }
  }

  const ordered = [...live.mutations].sort((a, b) => {
    const left = state.undoStacks.get(a.modelId)?.findIndex(mutation => mutation.id === a.id) ?? -1;
    const right = state.undoStacks.get(b.modelId)?.findIndex(mutation => mutation.id === b.id) ?? -1;
    return right - left;
  });
  const applied: Mutation[] = [];
  try {
    for (const mutation of ordered) {
      const view: MutablePropertyView | undefined = store.getState().mutationViews.get(mutation.modelId);
      if (!georef(mutation) && view?.isDeleted(mutation.entityId) && !lifecycle(mutation)) {
        throw new Error('The target was removed before this reversal.');
      }
      applyTarget(store, mutation, 'undo');
      applied.push(mutation);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const mutation of applied.reverse()) {
      try { applyTarget(store, mutation, 'redo'); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Could not restore a failed change reversal.');
    return { ok: false, reason: 'unsupported' };
  }

  const registry = inverseMutationTargets(store);
  for (const mutation of live.mutations) revertedMutationIds(store).add(mutation.id);
  let batchId: string | undefined;
  for (const modelId of live.modelIds) {
    const inverses = ordered.filter(mutation => mutation.modelId === modelId).map(mutation => ({
      ...mutation, id: `revert_${crypto.randomUUID()}`, timestamp: Date.now(),
    }));
    for (let index = 0; index < inverses.length; index++) registry.set(inverses[index].id, ordered.filter(mutation => mutation.modelId === modelId)[index]);
    batchId = store.getState().recordMutationBatch(modelId, inverses, batchId) ?? batchId;
  }
  // Likewise, Ctrl+Z must reach this newly recorded inverse command.
  store.getState().setActiveModel(live.modelIds[0]);
  return { ok: true, mode: 'inverse' };
}
