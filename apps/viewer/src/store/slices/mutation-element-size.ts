/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element's size, written one way (charter #6232, C4).
 *
 * The Model inspector's Dimensions rows and the push / pull handles both end
 * here, so a face dragged to 0.35 m and 0.35 typed into the field write the
 * same entities. Values cross this module in metres and are written in the
 * model's length unit; the positional writes land on the undo stack and the
 * caller's transaction tags them as one step and re-meshes what `remesh`
 * names.
 *
 *   - wall: thickness and height (`setWallSection`, which keeps its openings
 *     valid);
 *   - slab, roof, plate: thickness, the extrusion depth. A slab's openings are
 *     lengthened with it;
 *   - column, beam, member: length (the extrusion depth) from one end, and
 *     the rectangular section's two sides.
 *
 * Only the layouts the builders write are edited; anything else (a mapped or
 * tilted body, a profiled section) is refused with a reason, not guessed at.
 */

import { toNativeLength } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { hostBodyExtent, openingsOf, planCutRefit, type PositionalUpdate } from '@/lib/hosted-opening-refit.js';
import { resolveLinearElementChain } from '@/lib/linear-element-edit.js';
import { resolveSlabEditChain } from '@/lib/slab-edit.js';
import { modelEditTarget, type ModelEditTarget, type ModellingStore } from './mutation-modelling-records.js';
import { setWallSection, type WallSection } from './mutation-wall-section.js';

export type ElementSizePatch =
  | ({ readonly kind: 'wall' } & WallSection)
  | { readonly kind: 'slab'; readonly thickness: number }
  | {
      readonly kind: 'linear';
      /** Metres along the axis (the extrusion depth). */
      readonly length?: number;
      /** The section's side along the profile's X, and along its Y. */
      readonly width?: number;
      readonly cross?: number;
      /** Which end stays where it is when the length changes; default `start`. */
      readonly fixed?: 'start' | 'end';
    };

export type ElementSizeOutcome =
  | { readonly ok: true; readonly remesh: number[] }
  | { readonly ok: false; readonly reason: string };

/** IfcExtrudedAreaSolid.Depth; IfcRectangleProfileDef.XDim and YDim. */
const SOLID_DEPTH = 3;
const PROFILE_XDIM = 3;
const PROFILE_YDIM = 4;

/** A slab's or a column's, beam's or member's size as {@link setElementSize} edits it, in metres; null for any other layout. */
export type ElementSize =
  | { readonly kind: 'slab'; readonly thickness: number }
  | { readonly kind: 'linear'; readonly length: number; readonly width: number; readonly cross: number };

export function readElementSize(state: ViewerState, modelId: string, expressId: number): ElementSize | null {
  const target = modelEditTarget(state, modelId);
  if (!target) return null;
  const scale = getModelLengthUnitScale(target.dataStore);
  const slab = resolveSlabEditChain(target.dataStore, target.view, target.editor, expressId, scale);
  // A slab is only edited as a flat extrusion of its outline (see setSlabThickness).
  if (slab) return slab.baseElevation === null ? null : { kind: 'slab', thickness: slab.thickness };
  const linear = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  return linear ? { kind: 'linear', length: linear.depth, width: linear.profileWidth, cross: linear.profileHeight } : null;
}

const positive = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value > 0);

export function setElementSize(store: ModellingStore, modelId: string, expressId: number, patch: ElementSizePatch): ElementSizeOutcome {
  const get = store.getState;
  if (patch.kind === 'wall') return setWallSection(store, modelId, expressId, patch);
  const target = modelEditTarget(get(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  return patch.kind === 'slab'
    ? setSlabThickness(get, target, expressId, patch.thickness)
    : setLinearSize(get, target, expressId, patch);
}

function setSlabThickness(get: () => ViewerState, target: ModelEditTarget, expressId: number, thickness: number): ElementSizeOutcome {
  if (!(Number.isFinite(thickness) && thickness > 0)) return { ok: false, reason: 'Thickness must be greater than zero' };
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveSlabEditChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (!chain || chain.baseElevation === null) {
    return { ok: false, reason: 'This slab is not a flat extrusion of its outline, so its thickness cannot be edited here' };
  }
  if (Math.abs(chain.thickness - thickness) < 1e-9) return { ok: true, remesh: [] };
  const native = toNativeLength({ lengthUnitScale: scale }, thickness);
  const updates: PositionalUpdate[] = [{ entityId: chain.extrudedSolidId, index: SOLID_DEPTH, value: native }];
  const remesh = [expressId];
  if (openingsOf(target, expressId).length > 0) {
    const body = hostBodyExtent(target, expressId);
    if (!body) return { ok: false, reason: "This slab's body can't be read, so its openings can't follow the new thickness" };
    // The depth grows from the profile plane: the top when the slab is extruded up, the underside when it hangs.
    const extent: [number, number] = chain.extrusionUp ? [body.min[2], body.min[2] + native] : [body.max[2] - native, body.max[2]];
    const refit = planCutRefit(target, expressId, 2, extent, scale);
    if (!refit.ok) return refit;
    updates.push(...refit.updates);
    remesh.push(...refit.openings);
  }
  get().setPositionalAttributesBatch(target.modelId, updates);
  return { ok: true, remesh };
}

function setLinearSize(
  get: () => ViewerState,
  target: ModelEditTarget,
  expressId: number,
  size: Extract<ElementSizePatch, { kind: 'linear' }>,
): ElementSizeOutcome {
  if (![size.length, size.width, size.cross].every(positive)) return { ok: false, reason: 'Length and section sizes must be greater than zero' };
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (!chain) return { ok: false, reason: 'This element is not a straight extrusion of a rectangle, so its size cannot be edited here' };
  const unit = { lengthUnitScale: scale };
  const native = (metres: number) => toNativeLength(unit, metres);
  const updates: PositionalUpdate[] = [];
  if (size.length !== undefined && Math.abs(size.length - chain.depth) > 1e-9) {
    updates.push({ entityId: chain.extrudedSolidId, index: SOLID_DEPTH, value: native(size.length) });
    if (size.fixed === 'end') {
      // The start slides along the axis by what the length gave up.
      const grow = chain.depth - size.length;
      const [x, y, z] = chain.startCoordinates;
      const [dx, dy, dz] = chain.axisDirection;
      updates.push({ entityId: chain.startPointId, index: 0, value: [native(x + dx * grow), native(y + dy * grow), native(z + dz * grow)] });
    }
  }
  if (size.width !== undefined && Math.abs(size.width - chain.profileWidth) > 1e-9) {
    updates.push({ entityId: chain.profileId, index: PROFILE_XDIM, value: native(size.width) });
  }
  if (size.cross !== undefined && Math.abs(size.cross - chain.profileHeight) > 1e-9) {
    updates.push({ entityId: chain.profileId, index: PROFILE_YDIM, value: native(size.cross) });
  }
  get().setPositionalAttributesBatch(target.modelId, updates);
  return { ok: true, remesh: updates.length > 0 ? [expressId] : [] };
}
