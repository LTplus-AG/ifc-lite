/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addTranslation, equalTranslation, finiteTranslation, assertRenderableTranslation, subtractTranslation,
  ZERO_TRANSLATION, type MoveConstraint, type Translation } from './translation.js';
import { equalRotation, finiteRotation, normalizeAngle, pivotInModelFrame, ZERO_ROTATION, type ModelRotation } from './rotation.js';

export interface ModelPlacement {
  translation: Translation;
  /** Yaw about the workspace vertical axis, applied to the model's geometry
   * BEFORE `translation`. Vertical axis only — see `rotation.ts`. */
  rotation: ModelRotation;
  locked: boolean;
}

function samePlacement(a: ModelPlacement, b: ModelPlacement): boolean {
  return equalTranslation(a.translation, b.translation) && equalRotation(a.rotation, b.rotation);
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
  return state.placements.get(modelId) ?? { translation: ZERO_TRANSLATION, rotation: ZERO_ROTATION, locked: false };
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
  const changed = [...after].some(([id, value]) => !samePlacement(value,
    before.get(id) ?? { translation: ZERO_TRANSLATION, rotation: ZERO_ROTATION, locked: value.locked }));
  if (!changed) return cancelPlacement(state);
  const placements = new Map(state.placements);
  for (const [id, value] of after) placements.set(id, value);
  const revision = state.revision + 1;
  return { ...state, placements, preview: null, revision, redo: [],
    undo: [...state.undo.slice(-99), { id: revision, timestamp: Date.now(), before, after }] };
}

/** A placement as it arrives from outside. `rotation` is optional because a
 * record written before model rotation existed does not carry one; such a
 * record loads as no rotation rather than being rejected or discarded. */
export type IncomingPlacement = Omit<ModelPlacement, 'rotation'> & { rotation?: ModelRotation };

/** Import placements (translation and rotation) atomically and keep current locks authoritative. */
export function importPlacements(state: PlacementState, incoming: ReadonlyMap<string, IncomingPlacement>): PlacementState {
  const before = new Map<string, ModelPlacement>();
  const after = new Map<string, ModelPlacement>();
  for (const [id, incomingValue] of incoming) {
    const value: ModelPlacement = { ...incomingValue, rotation: incomingValue.rotation ?? ZERO_ROTATION };
    const current = placementFor(state, id);
    if (current.locked && !samePlacement(current, value)) {
      throw new Error('Unlock the affected models before importing their placements.');
    }
    assertRenderableTranslation(value.translation);
    assertRenderablePivot(value.rotation);
    before.set(id, current);
    after.set(id, { translation: [...value.translation],
      rotation: { angle: value.rotation.angle, pivot: [...value.rotation.pivot] }, locked: current.locked });
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
    after.set(id, { ...placement, translation: ZERO_TRANSLATION, rotation: ZERO_ROTATION });
  }
  return commitPlacements(state, before, after);
}

function assertRenderablePivot(rotation: ModelRotation): void {
  if (!finiteRotation(rotation)) throw new Error('Enter a finite rotation angle and pivot.');
  assertRenderableTranslation(rotation.pivot);
}

/**
 * Set the ABSOLUTE heading of every named model — not a delta, so re-editing
 * the angle cannot compound and the geometry bake can always restore its
 * pristine baseline and turn once.
 *
 * `rotation.pivot` is ONE workspace point for the whole selection. Each model
 * stores it in its own un-translated frame (rotation precedes translation), so
 * models with different translations still turn about the same point.
 *
 * One command for the whole group, so it undoes as one, exactly like a move.
 * Rotation has no preview stage: unlike a drag it is entered as a value, and
 * baking it costs a pass over the model's vertices.
 *
 * A PENDING MOVE PREVIEW IS CARRIED, NOT DROPPED. The models are drawn at
 * committed + preview delta, so that offset is the position the pivot was read
 * off and the move the Apply button was about to commit. Cancelling the preview
 * would put the models back without saying so and turn them about a point they
 * no longer sit on, so the move is committed WITH the heading, as one command,
 * and each model's pivot is taken against its moved translation.
 */
export function rotatePlacements(
  state: PlacementState, ids: readonly string[], rotation: ModelRotation,
): PlacementState {
  assertRenderablePivot(rotation);
  const normalized: ModelRotation = { angle: normalizeAngle(rotation.angle), pivot: [...rotation.pivot] };
  const rotating = new Set(ids);
  if (rotating.size === 0) throw new Error('Choose at least one model to rotate.');
  const preview = state.preview;
  const before = new Map<string, ModelPlacement>();
  const after = new Map<string, ModelPlacement>();
  // The previewed models too, even when they are not the ones being turned:
  // their pending move is committed by this command rather than discarded.
  for (const id of new Set([...rotating, ...(preview?.modelIds ?? [])])) {
    const placement = placementFor(state, id);
    if (placement.locked) {
      throw new Error(rotating.has(id) ? 'Unlock the selected models before rotating them.'
        : 'Unlock the previewed models before rotating.');
    }
    const translation = preview?.before.has(id)
      ? addTranslation(placement.translation, preview.delta) : placement.translation;
    assertRenderableTranslation(translation);
    // The DERIVED pivot too, not only the workspace one: a renderable pivot
    // less a renderable translation can still leave f32 range, and the bake
    // would turn the model about an infinite axis rather than refuse.
    if (rotating.has(id)) assertRenderableTranslation(pivotInModelFrame(normalized.pivot, translation));
    before.set(id, placement);
    after.set(id, rotating.has(id)
      ? { ...placement, translation, rotation: { angle: normalized.angle, pivot: pivotInModelFrame(normalized.pivot, translation) } }
      : { ...placement, translation });
  }
  // The preview's own `before` map is superseded by the one built here.
  return commitPlacements(cancelPlacement(state), before, after);
}

/**
 * Re-express every recorded pivot after the workspace frame ITSELF moved under
 * the models — the federation RTC convergence putting a model onto the shared
 * anchor (`hooks/ingest/federationRtcRebase.ts`, #4897).
 *
 * A translation is a DIFFERENCE of workspace points, so a frame shift leaves it
 * alone. A pivot is a POINT and is not: leaving it behind would turn the model
 * about a place kilometres from where the user put the axis, because the same
 * numbers now name somewhere else. History is rebased with the live placements,
 * or an undo would restore a pivot recorded in a frame no model is in any more.
 *
 * `deltas` is per model, in engineering workspace metres, and names only the
 * models that actually moved; a point moves by `-delta`, like the render-frame
 * origins the convergence shifts.
 */
export function rebasePlacementPivots(
  state: PlacementState, deltas: ReadonlyMap<string, Translation>,
): PlacementState {
  if (deltas.size === 0) return state;
  // Unchanged placements are returned by IDENTITY throughout, so the no-op case
  // can be detected and the revision left alone — bumping it would cancel an
  // in-flight asynchronous pick for nothing.
  const shift = (id: string, placement: ModelPlacement): ModelPlacement => {
    const delta = deltas.get(id);
    // A zero angle carries no meaningful pivot (`equalRotation` ignores it), so
    // moving it would only churn history.
    if (!delta || placement.rotation.angle === 0) return placement;
    return { ...placement, rotation: { angle: placement.rotation.angle,
      pivot: subtractTranslation(placement.rotation.pivot, delta) } };
  };
  const shiftMap = (map: ReadonlyMap<string, ModelPlacement>): ReadonlyMap<string, ModelPlacement> => {
    let moved = false;
    const next = new Map<string, ModelPlacement>();
    for (const [id, placement] of map) {
      const shifted = shift(id, placement);
      if (shifted !== placement) moved = true;
      next.set(id, shifted);
    }
    return moved ? next : map;
  };
  const shiftCommand = (command: PlacementCommand): PlacementCommand => {
    const before = shiftMap(command.before), after = shiftMap(command.after);
    return before === command.before && after === command.after ? command : { ...command, before, after };
  };
  const placements = shiftMap(state.placements);
  const undo = state.undo.map(shiftCommand), redo = state.redo.map(shiftCommand);
  // A pending move was picked against workspace points that have just moved, and
  // its two anchors can belong to models that moved by different deltas, so
  // there is no honest way to carry it. Cancelled, exactly as an explicit
  // re-alignment cancels it.
  const preview = state.preview && [...state.preview.modelIds, state.preview.source?.modelId,
    state.preview.target?.modelId].some((id) => id !== undefined && deltas.has(id))
    ? null : state.preview;
  if (placements === state.placements && preview === state.preview
    && undo.every((command, index) => command === state.undo[index])
    && redo.every((command, index) => command === state.redo[index])) return state;
  return { ...state, placements, preview, undo, redo, revision: state.revision + 1 };
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
