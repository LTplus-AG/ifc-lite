/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Model workspace's commands build with (charter #6232, M2): per
 * element kind, the dimensions a new element gets, plus the per-kind type and
 * material-layer-set picks and the drawing toggles the command bars write.
 *
 * Session-only: nothing here is persisted. Dimensions are the user's working
 * values and outlive a file swap; `typeIds` / `layerSetIds` name entities of
 * one model, so they die with that model (`model-removed`) and with a file
 * swap (`session-reset`).
 *
 * The command bars' typed fields and the inspector's defaults mode read and
 * write here, so the two always agree. Today `wall.place` / `wall.moveEndpoint`
 * read the wall's thickness and height, which the Add Element panel edits.
 */

import type { StateCreator } from 'zustand';
import { defineSliceTeardown } from '../teardown.js';

export type AuthoredElementKind =
  | 'wall'
  | 'slab'
  | 'beam'
  | 'column'
  | 'door'
  | 'window'
  | 'space'
  | 'roof'
  | 'plate'
  | 'member';

export type WallAlign = 'left' | 'centre' | 'right';
export type SlabDrawMode = 'rectangle' | 'polygon';
/** The IFC class the Slab bar writes: IfcSlab, IfcRoof or IfcPlate. */
export type SlabClass = Extract<AuthoredElementKind, 'slab' | 'roof' | 'plate'>;
/** The IFC class the Beam bar writes: IfcBeam or IfcMember. */
export type BeamClass = Extract<AuthoredElementKind, 'beam' | 'member'>;

/** An entity picked as a default, pinned to the model it lives in. */
interface ModelScopedPick {
  readonly modelId: string;
  readonly expressId: number;
}

export interface AuthoringDefaults {
  /** Builder parameter name (`Thickness`, `Height`, …) → metres, per kind. */
  readonly dims: Readonly<Record<AuthoredElementKind, Readonly<Record<string, number>>>>;
  /** Which face of a new wall the drawn line is. */
  readonly wallAlign: WallAlign;
  /** Keep drawing from the last end after a commit. */
  readonly chain: boolean;
  readonly slabMode: SlabDrawMode;
  /** How `space.place` draws its outline (interim until the Room tool). */
  readonly spaceMode: SlabDrawMode;
  readonly slabClass: SlabClass;
  readonly beamClass: BeamClass;
  readonly typeIds: Readonly<Partial<Record<AuthoredElementKind, ModelScopedPick>>>;
  readonly layerSetIds: Readonly<Partial<Record<AuthoredElementKind, ModelScopedPick>>>;
  /** The kind the last command built, for the inspector's empty state. */
  readonly lastKind: AuthoredElementKind;
}

export interface AuthoringDefaultsSlice {
  authoringDefaults: AuthoringDefaults;
  /** Merge dimension values into one kind's defaults. */
  setAuthoringDims: (kind: AuthoredElementKind, dims: Readonly<Record<string, number>>) => void;
  setAuthoringDefaults: (patch: Partial<Omit<AuthoringDefaults, 'dims'>>) => void;
}

/** The IfcCreator builders' construction-standard defaults. */
const AUTHORING_DIM_DEFAULTS: AuthoringDefaults['dims'] = {
  wall: { Thickness: 0.2, Height: 3 },
  slab: { Width: 5, Depth: 5, Thickness: 0.3 },
  // Bottom: the beam's underside above the workplane.
  beam: { Width: 0.3, Height: 0.5, Bottom: 0 },
  column: { Width: 0.4, Depth: 0.4, Height: 3 },
  door: { Width: 0.9, Height: 2.1, FrameThickness: 0.05 },
  window: { Width: 1.2, Height: 1.5, FrameThickness: 0.05, SillHeight: 0.9 },
  space: { Width: 4, Depth: 4, Height: 3 },
  roof: { Width: 8, Depth: 8, Thickness: 0.3 },
  plate: { Width: 1, Depth: 1, Thickness: 0.02 },
  member: { Width: 0.1, Height: 0.1, Bottom: 0 },
};

const INITIAL: AuthoringDefaults = {
  dims: AUTHORING_DIM_DEFAULTS,
  wallAlign: 'centre',
  chain: true,
  slabMode: 'rectangle',
  spaceMode: 'rectangle',
  slabClass: 'slab',
  beamClass: 'beam',
  typeIds: {},
  layerSetIds: {},
  lastKind: 'wall',
};

export const createAuthoringDefaultsSlice: StateCreator<AuthoringDefaultsSlice, [], [], AuthoringDefaultsSlice> = (set) => ({
  authoringDefaults: INITIAL,
  setAuthoringDims: (kind, dims) => set((s) => ({
    authoringDefaults: {
      ...s.authoringDefaults,
      dims: { ...s.authoringDefaults.dims, [kind]: { ...s.authoringDefaults.dims[kind], ...dims } },
    },
  })),
  setAuthoringDefaults: (patch) => set((s) => ({ authoringDefaults: { ...s.authoringDefaults, ...patch } })),
});

/** One kind's dimension, with the builder default when a value is missing. */
export function authoringDim(defaults: AuthoringDefaults, kind: AuthoredElementKind, name: string): number {
  return defaults.dims[kind][name] ?? AUTHORING_DIM_DEFAULTS[kind][name] ?? 0;
}

type Picks = AuthoringDefaults['typeIds'];

function dropModel(picks: Picks, modelId: string): Picks | null {
  const kept = Object.entries(picks).filter(([, pick]) => pick?.modelId !== modelId);
  return kept.length === Object.keys(picks).length ? null : Object.fromEntries(kept);
}

/** Type and layer-set picks name one model's entities; dimensions outlive it. */
export const authoringDefaultsTeardown = defineSliceTeardown('authoringDefaultsSlice', ['authoringDefaults'], {
  'session-reset': (_scope, state) => (state.authoringDefaults
    ? { authoringDefaults: { ...state.authoringDefaults, typeIds: {}, layerSetIds: {} } }
    : {}),
  'model-removed': (scope, state) => {
    const current = state.authoringDefaults;
    if (!current) return {};
    const typeIds = dropModel(current.typeIds, scope.modelId);
    const layerSetIds = dropModel(current.layerSetIds, scope.modelId);
    if (!typeIds && !layerSetIds) return {};
    return { authoringDefaults: { ...current, typeIds: typeIds ?? current.typeIds, layerSetIds: layerSetIds ?? current.layerSetIds } };
  },
  'all-models-cleared': (_scope, state) => (state.authoringDefaults
    ? { authoringDefaults: { ...state.authoringDefaults, typeIds: {}, layerSetIds: {} } }
    : {}),
});
