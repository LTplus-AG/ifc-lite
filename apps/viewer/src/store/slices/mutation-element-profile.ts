/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A beam's, column's or member's cross-section, read and written one way
 * (charter #6232, D2).
 *
 * The Model inspector's Profile section ends here: a rectangle turned into an
 * I, a circle into a hollow circle, or one dimension of an L changed. The
 * placing commands write the same sections through the in-store builders
 * (`addBeam` & co.), which call the same `emitProfileSection`, so a section
 * placed and a section changed later are the same IFC.
 *
 *   - rectangle to rectangle: the existing IfcRectangleProfileDef's XDim and
 *     YDim, positional writes (what a push / pull of its faces writes);
 *   - anything else: a new profile entity of the picked class, and the
 *     extrusion's SweptArea pointed at it. The old profile stays in the
 *     overlay, unreferenced, so undo is the one write that pointed away.
 *
 * Values cross this module in metres and are written in the model's length
 * unit. The positional writes land on the undo stack; the caller's transaction
 * tags them as one step and re-meshes what `remesh` names. Only the layout the
 * builders write is edited (a straight extrusion of a centred section);
 * anything else is refused with a reason, not guessed at.
 */

import { emitProfileSection, toNativeLength, validateProfileSection, type ProfileSection, type SpatialAnchor } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { resolveLinearElementChain } from '@/lib/linear-element-edit.js';
import { modelEditTarget } from './mutation-modelling-records.js';

export type ElementProfileOutcome =
  | { readonly ok: true; readonly remesh: number[] }
  | { readonly ok: false; readonly reason: string };

/** IfcExtrudedAreaSolid.SweptArea; IfcRectangleProfileDef.XDim and YDim. */
const SOLID_SWEPT_AREA = 0;
const PROFILE_XDIM = 3;
const PROFILE_YDIM = 4;

const NOT_EDITABLE = 'This element is not a straight extrusion of a centred section, so its profile cannot be edited here';

/**
 * The section `expressId` is extruded from, in metres: a `Rectangle` for a
 * plain rectangle, otherwise one of the picker's kinds. Null for any other layout.
 */
export function readElementProfile(state: ViewerState, modelId: string, expressId: number): ProfileSection | null {
  const target = modelEditTarget(state, modelId);
  if (!target) return null;
  const chain = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, getModelLengthUnitScale(target.dataStore));
  if (!chain) return null;
  return chain.profile ?? { Type: 'Rectangle', XDim: chain.profileWidth, YDim: chain.profileHeight };
}

const sameSection = (a: ProfileSection, b: ProfileSection): boolean => {
  const x = a as unknown as Record<string, number | string>;
  const y = b as unknown as Record<string, number | string>;
  const names = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...names].every((name) => (typeof x[name] === 'number' && typeof y[name] === 'number' ? Math.abs((x[name] as number) - (y[name] as number)) < 1e-9 : x[name] === y[name]));
};

export function setElementProfile(get: () => ViewerState, modelId: string, expressId: number, section: ProfileSection): ElementProfileOutcome {
  const target = modelEditTarget(get(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (!chain) return { ok: false, reason: NOT_EDITABLE };
  const unit = { schema: (target.dataStore.schemaVersion ?? 'IFC4') as SpatialAnchor['schema'], lengthUnitScale: scale };
  try {
    validateProfileSection(section, 'Profile');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.replace(/^Profile: /, '') : String(error) };
  }
  const current: ProfileSection = chain.profile ?? { Type: 'Rectangle', XDim: chain.profileWidth, YDim: chain.profileHeight };
  if (sameSection(current, section)) return { ok: true, remesh: [] };

  if (current.Type === 'Rectangle' && section.Type === 'Rectangle') {
    get().setPositionalAttributesBatch(modelId, [
      { entityId: chain.profileId, index: PROFILE_XDIM, value: toNativeLength(unit, section.XDim) },
      { entityId: chain.profileId, index: PROFILE_YDIM, value: toNativeLength(unit, section.YDim) },
    ]);
    return { ok: true, remesh: [expressId] };
  }
  let profileId: number;
  try {
    profileId = emitProfileSection(target.editor, unit, section, 'Profile');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  get().setPositionalAttributesBatch(modelId, [{ entityId: chain.extrudedSolidId, index: SOLID_SWEPT_AREA, value: `#${profileId}` }]);
  return { ok: true, remesh: [expressId] };
}
