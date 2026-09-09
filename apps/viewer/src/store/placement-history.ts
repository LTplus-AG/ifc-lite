/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StateCreator } from 'zustand';
import type { ViewerState } from './index.js';
import { recordOperation } from '../lib/model-placement/operation-order';

type HistoryState = Pick<ViewerState, 'modelPlacement' | 'undoStacks' | 'redoStacks'>
  & Partial<Pick<ViewerState, 'referenceUndo' | 'referenceRedo'>>;

/** A new operation creates a history branch across authoring and workspace
 * movement. Replaying an existing redo entry must preserve the rest of redo. */
export function invalidatePlacementHistoryBranch<T extends HistoryState>(state: T, patch: Partial<T>): Partial<T> {
  const reference = patch.referenceUndo?.at(-1);
  if (reference) recordOperation(reference);
  const addedReference = reference && !state.referenceUndo?.includes(reference) && !state.referenceRedo?.includes(reference);
  if (addedReference) return { ...patch, redoStacks: new Map(),
    modelPlacement: { ...(patch.modelPlacement ?? state.modelPlacement), redo: [] } };
  const top = patch.modelPlacement?.undo.at(-1);
  if (top) recordOperation(top);
  if (patch.undoStacks) for (const stack of patch.undoStacks.values()) {
    const command = stack.at(-1);
    if (command) recordOperation(command);
  }
  const placement = patch.modelPlacement;
  const newMove = placement?.undo.at(-1);
  const addedMove = newMove && !state.modelPlacement.undo.includes(newMove) && !state.modelPlacement.redo.includes(newMove);
  if (addedMove) return { ...patch, redoStacks: new Map(), ...(state.referenceRedo ? { referenceRedo: [] } : {}) };
  if (patch.undoStacks && (state.modelPlacement.redo.length > 0 || state.referenceRedo?.length)) {
    for (const [id, stack] of patch.undoStacks) {
      const command = stack.at(-1);
      if (command && !(state.undoStacks.get(id) ?? []).includes(command) && !(state.redoStacks.get(id) ?? []).includes(command)) {
        return { ...patch, modelPlacement: { ...(placement ?? state.modelPlacement), redo: [] },
          ...(state.referenceRedo ? { referenceRedo: [] } : {}) };
      }
    }
  }
  return patch;
}

/** Cover every mutation producer, including direct store writes, without
 * introducing a second list of authoring commands that can drift. */
export function withPlacementHistory(creator: StateCreator<ViewerState>): StateCreator<ViewerState> {
  return (set, get, api) => {
    const guarded: typeof set = (partial, replace) => {
      const update = (state: ViewerState) => invalidatePlacementHistoryBranch(state,
        typeof partial === 'function' ? partial(state) : partial);
      if (replace) set((state) => update(state) as ViewerState, true);
      else set(update);
    };
    api.setState = guarded;
    return creator(guarded, get, api);
  };
}
