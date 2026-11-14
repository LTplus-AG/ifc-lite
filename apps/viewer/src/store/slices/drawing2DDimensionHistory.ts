/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo/redo for 2D drawing dimensions (and only dimensions: no other 2D
 * markup has history). Split out of `drawing2DDimensions.ts` to keep that
 * module inside its size budget.
 *
 * Same shape as `appearanceReferenceSlice.ts`: a command holds the whole
 * dimension list before and after, the undo stack is capped, a new command
 * clears redo, and replay moves commands between the stacks without
 * recording. The lists are deep-copied in and out, so history never aliases
 * live state. In-progress `dimension2DPoints` are not history.
 *
 * Scope: dimensions live in the active model's markup (per-model cache,
 * persisted per model), not per drawing, so history belongs to that markup.
 * It is cleared when it is replaced: session reset, and any change of
 * `activeModelId` (including removal of the active model); see
 * `drawing2DSlice.markupTransition.ts` and `drawing2DSlice.teardown.ts`.
 */

import type { Dimension2D } from './drawing2DDimensions';
import type { SelectedAnnotation2D } from './drawing2DSlice';

export type Dimension2DCommandKind = 'add' | 'update' | 'remove' | 'clear';

export interface Dimension2DCommand {
  kind: Dimension2DCommandKind;
  before: Dimension2D[];
  after: Dimension2D[];
}

export interface Dimension2DHistoryState {
  dimensions2D: Dimension2D[];
  dimension2DUndo: Dimension2DCommand[];
  dimension2DRedo: Dimension2DCommand[];
  selectedAnnotation2D: SelectedAnnotation2D | null;
}

export const MAX_DIMENSION_2D_HISTORY = 100;

const copy = (list: Dimension2D[]): Dimension2D[] => structuredClone(list);

/** Selectors: `useViewerStore(canUndoDimension2D)`. */
export const canUndoDimension2D = (s: Pick<Dimension2DHistoryState, 'dimension2DUndo'>): boolean => s.dimension2DUndo.length > 0;
export const canRedoDimension2D = (s: Pick<Dimension2DHistoryState, 'dimension2DRedo'>): boolean => s.dimension2DRedo.length > 0;

/** The patch that commits `after` as a new recorded command. */
export function recordDimensionChange(
  state: Pick<Dimension2DHistoryState, 'dimensions2D' | 'dimension2DUndo'>,
  kind: Dimension2DCommandKind,
  after: Dimension2D[],
  before: Dimension2D[] = state.dimensions2D,
): Pick<Dimension2DHistoryState, 'dimensions2D' | 'dimension2DUndo' | 'dimension2DRedo'> {
  const command: Dimension2DCommand = { kind, before: copy(before), after: copy(after) };
  return {
    dimensions2D: after,
    dimension2DUndo: [...state.dimension2DUndo, command].slice(-MAX_DIMENSION_2D_HISTORY),
    dimension2DRedo: [],
  };
}

/** The patch that replays the newest command of one stack; `{}` when it is empty. Never records. */
export function replayDimensionChange(state: Dimension2DHistoryState, direction: 'undo' | 'redo'): Partial<Dimension2DHistoryState> {
  const source = direction === 'undo' ? state.dimension2DUndo : state.dimension2DRedo;
  const command = source.at(-1);
  if (!command) return {};
  const dimensions2D = copy(direction === 'undo' ? command.before : command.after);
  const selected = state.selectedAnnotation2D;
  const selectedAnnotation2D = selected?.type === 'dimension' && !dimensions2D.some((d) => d.id === selected.id)
    ? null : selected;
  return direction === 'undo'
    ? { dimensions2D, selectedAnnotation2D, dimension2DUndo: source.slice(0, -1), dimension2DRedo: [...state.dimension2DRedo, command] }
    : { dimensions2D, selectedAnnotation2D, dimension2DRedo: source.slice(0, -1), dimension2DUndo: [...state.dimension2DUndo, command].slice(-MAX_DIMENSION_2D_HISTORY) };
}

/**
 * History rebased onto restored markup: every snapshot gains the stored
 * dimensions it lacks, so undoing what was drawn while a restore resolved
 * removes only that, never the restored entries.
 */
export function rebaseDimensionHistory(commands: Dimension2DCommand[], rebase: (snapshot: Dimension2D[]) => Dimension2D[]): Dimension2DCommand[] {
  return commands.map((c) => ({ ...c, before: rebase(c.before), after: rebase(c.after) }));
}
