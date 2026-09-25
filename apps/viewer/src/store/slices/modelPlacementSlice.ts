/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StateCreator } from 'zustand';
import type { ViewerState } from '../index.js';
import { defineSliceTeardown } from '../teardown.js';
import { beginPlacement, cancelPlacement, commitPlacement, emptyPlacementState, previewPlacement,
  rebasePlacementPivots, replayPlacement, resetPlacements, retainLoadedPlacements, placementFor, importPlacements,
  rotatePlacements, type PlacementAnchor, type PlacementState } from '../../lib/model-placement/state.js';
import type { ModelRotation } from '../../lib/model-placement/rotation.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';
import { rotationRefusal } from '../../lib/model-placement/rotation-refusal.js';
import { constrainTranslation, finiteTranslation, fromRenderTranslation, subtractTranslation,
  type Translation, type MoveConstraint } from '../../lib/model-placement/translation.js';
import type { Vec3 } from '@ifc-lite/geometry';
import { type PlacementManifest, resolvePlacementManifest } from '../../lib/model-placement/manifest.js';
import { placementFrameKey } from '../../lib/model-placement/persistence.js';

export interface ModelPlacementSlice {
  modelPlacement: PlacementState;
  repositionOpen: boolean;
  placementStaleMeasurements: ReadonlySet<string>;
  repositionNudge: number;
  openReposition: (modelIds?: readonly string[]) => void;
  closeReposition: () => void;
  previewModelTranslation: (delta: Translation) => void;
  setMoveConstraint: (constraint: MoveConstraint) => void;
  setMoveAnchor: (role: 'source' | 'target', anchor: PlacementAnchor) => void;
  applyModelTranslation: () => void;
  undoModelTranslation: () => void;
  redoModelTranslation: () => void;
  resetModelTranslations: (ids: readonly string[]) => void;
  /** Set the ABSOLUTE heading of the named models about the workspace vertical
   * axis through `rotation.pivot`, a workspace point. Undoes with the moves, on
   * the same stack. */
  setModelRotation: (ids: readonly string[], rotation: ModelRotation) => void;
  setModelPositionLocked: (modelId: string, locked: boolean) => void;
  /**
   * Follow recorded pivots onto a new RTC anchor after the federation
   * convergence moved a model's render frame (`federationRtcRebase.ts`).
   * `deltas` are RENDER-frame (Y-up) vectors per moved model; the placement
   * state keeps engineering Z-up metres, so they are converted here rather
   * than teaching the frame code about workspace axes.
   */
  rebasePlacementFrame: (deltas: ReadonlyMap<string, Vec3>) => void;
  setRepositionNudge: (metres: number) => void;
  importModelPlacements: (manifest: PlacementManifest, bindings?: ReadonlyMap<string, string>) => void;
}

export const createModelPlacementSlice: StateCreator<ViewerState, [], [], ModelPlacementSlice> = (set, get) => ({
  modelPlacement: emptyPlacementState(), repositionOpen: false, repositionNudge: 0.001, placementStaleMeasurements: new Set<string>(),
  importModelPlacements: (manifest, bindings) => set((state) => {
    const incoming = resolvePlacementManifest(manifest, state.models, placementFrameKey(state), bindings);
    // Refused like an unlocked-model conflict: atomically, with the reason shown
    // by the import panel, rather than silently dropping the heading.
    // The same refusal the rotate command applies, so no path can record a
    // heading the bake would only partly carry out.
    const refusal = rotationRefusal(state, [...incoming].filter(([, placement]) => placement.rotation.angle !== 0).map(([id]) => id));
    if (refusal) throw new Error(refusal);
    return { modelPlacement: importPlacements(state.modelPlacement, incoming) };
  }),
  openReposition: (modelIds) => {
    const state = get();
    const ids = modelIds ?? (state.activeModelId ? [state.activeModelId] : [...state.models.keys()].slice(0, 1));
    const modelPlacement = beginPlacement(state.modelPlacement, ids, new Set(state.models.keys()));
    state.setActiveTool('select', 'programmatic');
    set({ modelPlacement, repositionOpen: true });
  },
  closeReposition: () => set((state) => ({ repositionOpen: false, modelPlacement: cancelPlacement(state.modelPlacement) })),
  previewModelTranslation: (delta) => set((state) => ({ modelPlacement: previewPlacement(state.modelPlacement,
    constrainTranslation(delta, state.modelPlacement.preview?.constraint ?? 'free')) })),
  setMoveConstraint: (constraint) => set((state) => {
    const preview = state.modelPlacement.preview;
    if (!preview) return {};
    return { modelPlacement: { ...previewPlacement(state.modelPlacement, constrainTranslation(preview.delta, constraint)),
      preview: { ...preview, delta: constrainTranslation(preview.delta, constraint), constraint } } };
  }),
  setMoveAnchor: (role, anchor) => set((state) => {
    const preview = state.modelPlacement.preview;
    if (!preview) throw new Error('Start repositioning first.');
    if (!state.models.has(anchor.modelId) || !finiteTranslation(anchor.point)) throw new Error('The reference point is no longer available.');
    const moving = preview.before.has(anchor.modelId);
    if ((role === 'source' && !moving) || (role === 'target' && moving)) {
      throw new Error(role === 'source' ? 'Pick a point on a moving model.' : 'Pick a point on a fixed reference model.');
    }
    const next = { ...preview, [role]: { ...anchor, point: [...anchor.point] as Translation } };
    // A source re-picked during a preview is converted back to the committed frame.
    if (role === 'source') next.source = { ...anchor, point: subtractTranslation(anchor.point, preview.delta) };
    const delta = next.source && next.target
      ? constrainTranslation(subtractTranslation(next.target.point, next.source.point), next.constraint) : preview.delta;
    const checked = previewPlacement(state.modelPlacement, delta);
    return { modelPlacement: { ...checked, preview: { ...next, delta } } };
  }),
  // Neither this nor `setModelRotation` stamps a frame identity onto
  // `modelPlacement` (#4936): `placementFrameKey`/`placementFrameBaseKey`
  // (`persistence.ts`) recompute the frame fresh from live `state.models` on
  // every read, so there is nothing here to keep warm, and nothing that could
  // go stale under a later RTC convergence or a model leaving the federation.
  applyModelTranslation: () => set((state) => ({ modelPlacement: commitPlacement(state.modelPlacement) })),
  undoModelTranslation: () => set((state) => ({ modelPlacement: replayPlacement(state.modelPlacement, 'undo') })),
  redoModelTranslation: () => set((state) => ({ modelPlacement: replayPlacement(state.modelPlacement, 'redo') })),
  resetModelTranslations: (ids) => set((state) => {
    if (ids.some((id) => !state.models.has(id))) throw new Error('A selected model is no longer loaded.');
    return { modelPlacement: resetPlacements(state.modelPlacement, ids) };
  }),
  setModelRotation: (ids, rotation) => set((state) => {
    if (ids.some((id) => !state.models.has(id))) throw new Error('A selected model is no longer loaded.');
    // A rotation is baked into flat mesh geometry. Pointclouds and GPU-instanced
    // occurrences are drawn from renderer data it never touches, so refuse
    // rather than turn part of the selection (see rotation-refusal.ts).
    const refusal = rotationRefusal(state, ids);
    if (refusal) throw new Error(refusal);
    return { modelPlacement: rotatePlacements(state.modelPlacement, ids, rotation) };
  }),
  rebasePlacementFrame: (deltas) => set((state) => {
    const workspace = new Map([...deltas].map(([id, delta]) => [id, fromRenderTranslation(delta)] as const));
    const rebased = rebasePlacementPivots(state.modelPlacement, workspace);
    return rebased === state.modelPlacement ? {} : { modelPlacement: rebased };
  }),
  setModelPositionLocked: (modelId, locked) => set((state) => {
    if (!state.models.has(modelId)) return {};
    const base = state.modelPlacement.preview?.before.has(modelId) ? cancelPlacement(state.modelPlacement) : state.modelPlacement;
    const placements = new Map(base.placements);
    placements.set(modelId, { ...placementFor(base, modelId), locked });
    return { modelPlacement: { ...base, placements, revision: base.revision + 1 } };
  }),
  setRepositionNudge: (metres) => {
    if (!Number.isFinite(metres) || metres <= 0) throw new Error('Nudge increment must be a positive distance.');
    set({ repositionNudge: metres });
  },
});

export const modelPlacementTeardown = defineSliceTeardown('modelPlacementSlice',
  ['modelPlacement', 'repositionOpen', 'repositionNudge', 'placementStaleMeasurements'], {
    // The baselines go with the geometry they describe — nothing to restore
    // them onto once the models are gone, and they are geometry-sized.
    'session-reset': () => { modelRotationBaker.clear(); return { modelPlacement: emptyPlacementState(), repositionOpen: false, repositionNudge: 0.001, placementStaleMeasurements: new Set<string>() }; },
    'all-models-cleared': () => { modelRotationBaker.clear(); return { modelPlacement: emptyPlacementState(), repositionOpen: false, repositionNudge: 0.001, placementStaleMeasurements: new Set<string>() }; },
    'model-removed': (scope, state) => {
      modelRotationBaker.forget(scope.modelId);
      if (!state.modelPlacement) return {};
      const ids = new Set(state.models?.keys());
      ids.delete(scope.modelId);
      return { modelPlacement: retainLoadedPlacements(state.modelPlacement, ids),
        repositionOpen: ids.size > 0 && state.repositionOpen === true && !state.modelPlacement.preview?.modelIds.includes(scope.modelId) };
    },
  });
