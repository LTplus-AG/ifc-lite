/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Mutation } from '@ifc-lite/mutations';
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

/** The model an authoring dialog (Bulk editor, CSV import) targets when it
 * opens: the active one, whose history Undo replays, else the first (#5958). */
export function defaultAuthoringModelId(models: ReadonlyArray<{ id: string }>, activeModelId: string | null): string {
  return models.find((m) => m.id === activeModelId)?.id ?? models[0]?.id ?? '';
}

/**
 * Record a chunked run that writes straight to `modelId`'s view (Bulk editor,
 * CSV import) as each chunk lands. One batch id makes the run ONE undo step
 * (#5861); recording as it goes keeps an edit made during one of its yields
 * in commit order, so undoing the run cannot overwrite it; and the first
 * recorded chunk makes the model active (once, so a switch mid-run sticks),
 * because Ctrl+Z and the ribbon Undo replay only the active model's history
 * (#5958).
 */
export function recordRun(getState: () => ViewerState, modelId: string): (mutations: readonly Mutation[]) => void {
  let batchId: string | undefined;
  return (mutations) => {
    const state = getState();
    if (mutations.length === 0) return;
    if (batchId === undefined && state.activeModelId !== modelId && state.models.has(modelId)) state.setActiveModel(modelId);
    batchId = state.recordMutationBatch(modelId, mutations, batchId) ?? batchId;
  };
}
