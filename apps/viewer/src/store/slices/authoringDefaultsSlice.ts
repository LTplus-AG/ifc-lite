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
import type { ProfileSection, ProfileSectionType } from '@ifc-lite/create';
import { defineSliceTeardown } from '../teardown.js';
import { sectionOfType } from '@/lib/profile-section/profile-kinds';

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

/** The kinds whose cross-section the Model workspace picks: a Beam or Member bar (its class), and the Column bar. */
export type ProfileOwner = Extract<AuthoredElementKind, 'beam' | 'member' | 'column'>;

/**
 * The section a new beam, column or member is built with: its kind, and the
 * dimensions last typed for each kind, so switching I, then Circle, then back
 * to I finds the I as it was left. The rectangle's own dimensions are the
 * kind's `dims` (Width x Height, Width x Depth), so `Rectangle` has none here.
 */
export interface ProfileChoice {
  readonly type: ProfileSectionType;
  readonly dims: Readonly<Partial<Record<ProfileSectionType, Readonly<Record<string, number>>>>>;
}

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
  /** How the Room tool's Draw mode outlines a free room. */
  readonly spaceMode: SlabDrawMode;
  readonly slabClass: SlabClass;
  readonly beamClass: BeamClass;
  /** The cross-section per owner; `Rectangle` (the initial value) writes the kind's Width x Height. */
  readonly profiles: Readonly<Record<ProfileOwner, ProfileChoice>>;
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
  /** Pick `owner`'s section kind, and remember its dimensions (`dims` merges over the kind's remembered ones). */
  setAuthoringProfile: (owner: ProfileOwner, kind: ProfileSectionType, dims?: Readonly<Record<string, number>>) => void;
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
  profiles: { beam: { type: 'Rectangle', dims: {} }, member: { type: 'Rectangle', dims: {} }, column: { type: 'Rectangle', dims: {} } },
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
  setAuthoringProfile: (owner, kind, dims) => set((s) => {
    const choice = s.authoringDefaults.profiles[owner];
    return {
      authoringDefaults: {
        ...s.authoringDefaults,
        profiles: { ...s.authoringDefaults.profiles, [owner]: { type: kind, dims: dims ? { ...choice.dims, [kind]: { ...choice.dims[kind], ...dims } } : choice.dims } },
      },
    };
  }),
});

/**
 * The section a new element of `owner` is built with, or null for the plain
 * rectangle (written as Width x Height, the way it always was).
 */
export function authoringSection(defaults: AuthoringDefaults, owner: ProfileOwner): ProfileSection | null {
  const { type, dims } = defaults.profiles[owner];
  return type === 'Rectangle' ? null : sectionOfType(type, dims[type]);
}

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

/** {@link authoringSection}, with the plain rectangle (Width x Height, a column's Width x Depth) drawn as a section too: what a preview shows. */
export function authoringShownSection(defaults: AuthoringDefaults, owner: ProfileOwner): ProfileSection {
  return authoringSection(defaults, owner)
    ?? { Type: 'Rectangle', XDim: authoringDim(defaults, owner, 'Width'), YDim: authoringDim(defaults, owner, owner === 'column' ? 'Depth' : 'Height') };
}
