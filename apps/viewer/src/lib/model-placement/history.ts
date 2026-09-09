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
  const placementFirst = placement && (!mutation || (direction === 'undo'
    ? compareOperations(placement, mutation) >= 0 : compareOperations(placement, mutation) <= 0));
  if (placementFirst) {
    if (direction === 'undo') state.undoModelTranslation(); else state.redoModelTranslation();
  } else if (modelId) {
    if (direction === 'undo') state.undo(modelId); else state.redo(modelId);
  }
}
