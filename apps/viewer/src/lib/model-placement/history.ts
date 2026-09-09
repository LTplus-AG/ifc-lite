/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { compareOperations } from './operation-order';

/** Preserve active-model authoring scope, interleaving workspace translations
 * by commit order. Redo reverses undo's order (oldest undone operation first). */
export function replayWorkspaceHistory(state: ViewerState, direction: 'undo' | 'redo'): void {
  if (state.modelPlacement.preview?.delta.some((value) => value !== 0)) {
    state.closeReposition();
    return;
  }
  const placement = state.modelPlacement[direction].at(-1);
  const modelId = state.activeModelId;
  const mutation = modelId ? state[direction === 'undo' ? 'undoStacks' : 'redoStacks'].get(modelId)?.at(-1) : undefined;
  const reference = state[direction === 'undo' ? 'referenceUndo' : 'referenceRedo']?.at(-1);
  const candidates = [
    ...(placement ? [{ command: placement, replay: () => direction === 'undo' ? state.undoModelTranslation() : state.redoModelTranslation() }] : []),
    ...(mutation && modelId ? [{ command: mutation, replay: () => direction === 'undo' ? state.undo(modelId) : state.redo(modelId) }] : []),
    ...(reference ? [{ command: reference, replay: () => state.replayAppearanceReference(direction) }] : []),
  ];
  candidates.sort((a, b) => direction === 'undo' ? compareOperations(b.command, a.command) : compareOperations(a.command, b.command));
  candidates[0]?.replay();
}

export function hasWorkspaceHistory(state: ViewerState, direction: 'undo' | 'redo'): boolean {
  return state.modelPlacement[direction].length > 0
    || (state[direction === 'undo' ? 'referenceUndo' : 'referenceRedo']?.length ?? 0) > 0
    || (state.activeModelId !== null && (state[direction === 'undo' ? 'undoStacks' : 'redoStacks'].get(state.activeModelId)?.length ?? 0) > 0);
}
