/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addTranslation, equalTranslation, finiteTranslation, assertRenderableTranslation, ZERO_TRANSLATION,
  type MoveConstraint, type Translation } from './translation.js';

export interface ModelPlacement {
  translation: Translation;
  locked: boolean;
}

export interface PlacementAnchor {
  modelId: string;
  /** Captured in the stable workspace frame, engineering axes, metres. */
  point: Translation;
  kind: 'point' | 'vertex' | 'edge' | 'face' | 'origin' | 'bounds';
}

export interface PlacementPreview {
  modelIds: readonly string[];
  before: ReadonlyMap<string, ModelPlacement>;
  delta: Translation;
  constraint: MoveConstraint;
  source: PlacementAnchor | null;
  target: PlacementAnchor | null;
}

export interface PlacementCommand {
  id: number;
  timestamp: number;
  before: ReadonlyMap<string, ModelPlacement>;
  after: ReadonlyMap<string, ModelPlacement>;
}

export interface PlacementState {
  /** Frame actually used for these positions, independent of a pending anchor choice. */
  frameKey: string | null;
  placements: ReadonlyMap<string, ModelPlacement>;
  preview: PlacementPreview | null;
  undo: readonly PlacementCommand[];
  redo: readonly PlacementCommand[];
  /** Changes on previews too, so an old asynchronous pick cannot commit. */
  revision: number;
}

export function emptyPlacementState(): PlacementState {
  return { frameKey: null, placements: new Map(), preview: null, undo: [], redo: [], revision: 0 };
}

export function placementFor(state: PlacementState, modelId: string): ModelPlacement {
  return state.placements.get(modelId) ?? { translation: ZERO_TRANSLATION, locked: false };
}

export function displayedTranslation(state: PlacementState, modelId: string): Translation {
  const committed = placementFor(state, modelId).translation;
  return state.preview?.before.has(modelId) ? addTranslation(committed, state.preview.delta) : committed;
}

export function beginPlacement(
  state: PlacementState, ids: readonly string[], loadedIds: ReadonlySet<string>,
): PlacementState {
  const modelIds = [...new Set(ids)];
  if (modelIds.length === 0) throw new Error('Choose at least one model to reposition.');
  const before = new Map<string, ModelPlacement>();
  for (const id of modelIds) {
    if (!loadedIds.has(id)) throw new Error('A selected model is no longer loaded.');
    const placement = placementFor(state, id);
    if (placement.locked) throw new Error('Unlock the selected models before repositioning.');
    before.set(id, placement);
  }
  return { ...state, revision: state.revision + 1, preview: {
    modelIds, before, delta: ZERO_TRANSLATION, constraint: 'free', source: null, target: null,
  } };
}

export function previewPlacement(state: PlacementState, delta: Translation): PlacementState {
  if (!state.preview) throw new Error('Start repositioning a model first.');
  if (!finiteTranslation(delta)) throw new Error('Enter three finite translation components.');
  // Validate every final coordinate before publishing ANY of the group preview.
  for (const placement of state.preview.before.values()) assertRenderableTranslation(addTranslation(placement.translation, delta));
  return { ...state, revision: state.revision + 1, preview: { ...state.preview, delta: [...delta] } };
}

export function cancelPlacement(state: PlacementState): PlacementState {
  return state.preview ? { ...state, preview: null, revision: state.revision + 1 } : state;
}

/** One operation for the entire group; no-op moves do not discard redo history. */
export function commitPlacement(state: PlacementState): PlacementState {
  const preview = state.preview;
  if (!preview) return state;
  const after = new Map<string, ModelPlacement>();
  for (const [id, placement] of preview.before) {
    after.set(id, { ...placement, translation: addTranslation(placement.translation, preview.delta) });
  }
  return commitPlacements(state, preview.before, after);
}

function commitPlacements(
  state: PlacementState, before: ReadonlyMap<string, ModelPlacement>, after: ReadonlyMap<string, ModelPlacement>,
): PlacementState {
  const changed = [...after].some(([id, value]) => !equalTranslation(value.translation,
    before.get(id)?.translation ?? ZERO_TRANSLATION));
  if (!changed) return cancelPlacement(state);
  const placements = new Map(state.placements);
  for (const [id, value] of after) placements.set(id, value);
  const revision = state.revision + 1;
  return { ...state, placements, preview: null, revision, redo: [],
    undo: [...state.undo.slice(-99), { id: revision, timestamp: Date.now(), before, after }] };
}

/** Import positions atomically and keep current locks authoritative. */
export function importPlacements(state: PlacementState, incoming: ReadonlyMap<string, ModelPlacement>): PlacementState {
  const before = new Map<string, ModelPlacement>();
  const after = new Map<string, ModelPlacement>();
  for (const [id, value] of incoming) {
    const current = placementFor(state, id);
    if (current.locked && !equalTranslation(current.translation, value.translation)) {
      throw new Error('Unlock the affected models before importing their positions.');
    }
    assertRenderableTranslation(value.translation);
    before.set(id, current);
    after.set(id, { translation: [...value.translation], locked: current.locked });
  }
  return commitPlacements(state, before, after);
}

export function resetPlacements(state: PlacementState, ids: readonly string[]): PlacementState {
  const before = new Map<string, ModelPlacement>();
  const after = new Map<string, ModelPlacement>();
  for (const id of ids) {
    const placement = placementFor(state, id);
    if (placement.locked) throw new Error('Unlock the selected models before resetting placement.');
    before.set(id, placement);
    after.set(id, { ...placement, translation: ZERO_TRANSLATION });
  }
  return commitPlacements(state, before, after);
}

export function replayPlacement(state: PlacementState, direction: 'undo' | 'redo'): PlacementState {
  const stack = state[direction];
  const command = stack.at(-1);
  if (!command) return cancelPlacement(state);
  const values = direction === 'undo' ? command.before : command.after;
  const placements = new Map(state.placements);
  for (const [id, value] of values) {
    // Undo affects position, never a subsequently-changed position lock.
    placements.set(id, { ...value, locked: placementFor(state, id).locked });
  }
  return { ...state, placements, preview: null, revision: state.revision + 1,
    [direction]: stack.slice(0, -1),
    [direction === 'undo' ? 'redo' : 'undo']: [...state[direction === 'undo' ? 'redo' : 'undo'], command],
  };
}

/** A removed member invalidates its entire atomic group history entry. */
export function retainLoadedPlacements(state: PlacementState, ids: ReadonlySet<string>): PlacementState {
  const valid = (command: PlacementCommand) => [...command.before.keys()].every((id) => ids.has(id));
  const preview = state.preview;
  const previewValid = !preview || (preview.modelIds.every((id) => ids.has(id)) &&
    (!preview.source || ids.has(preview.source.modelId)) && (!preview.target || ids.has(preview.target.modelId)));
  const placements = new Map([...state.placements].filter(([id]) => ids.has(id)));
  const undo = state.undo.filter(valid), redo = state.redo.filter(valid);
  if (placements.size === state.placements.size && undo.length === state.undo.length &&
    redo.length === state.redo.length && previewValid) return state;
  return { ...state, placements, undo, redo, preview: previewValid ? preview : null, revision: state.revision + 1 };
}
