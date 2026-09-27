/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation } from '@ifc-lite/mutations';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '../index.js';

// A Changes-drawer Revert is an ordinary new undo step, but its replay uses
// the original mutation's existing inverse/forward handlers. This private
// mapping keeps viewer-only history metadata out of the published API (#5902).
interface HistoryRegistry {
  inverseTargets: Map<string, Mutation>;
  revertedIds: Set<string>;
}
const byStore = new WeakMap<StoreApi<ViewerState>['getState'], HistoryRegistry>();

function historyRegistry(store: StoreApi<ViewerState>): HistoryRegistry {
  let entries = byStore.get(store.getState);
  if (!entries) {
    entries = { inverseTargets: new Map(), revertedIds: new Set() };
    byStore.set(store.getState, entries);
  }
  return entries;
}

/** A discarded redo branch must not make an undone raw view record look like
 * an untracked direct write in the JSON delta (#5902). */
export function revertedMutationIds(store: StoreApi<ViewerState>): Set<string> {
  return historyRegistry(store).revertedIds;
}

export function inverseMutationTargets(store: StoreApi<ViewerState>): Map<string, Mutation> {
  return historyRegistry(store).inverseTargets;
}

/** Forget commands pruned by redo branching, model removal, or peer edits. */
export function pruneInverseMutationTargets(store: StoreApi<ViewerState>): void {
  const entries = byStore.get(store.getState)?.inverseTargets;
  if (!entries?.size) return;
  const { undoStacks, redoStacks } = store.getState();
  const retained = new Set<string>();
  for (const stacks of [undoStacks, redoStacks]) {
    for (const stack of stacks.values()) for (const mutation of stack) retained.add(mutation.id);
  }
  for (const id of entries.keys()) if (!retained.has(id)) entries.delete(id);
}
