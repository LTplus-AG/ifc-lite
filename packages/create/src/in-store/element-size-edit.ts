/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { toNativeLength } from './anchor.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { hostBodyExtent, openingsOf, planCutRefit, type PositionalUpdate } from './edit/hosted-opening-refit.js';
import { resolveLinearElementChain } from './edit/linear-element-edit.js';
import { resolveSlabEditChain } from './edit/slab-edit.js';
import type { EditTarget } from './edit/target.js';
import { setWallSectionInStore, type WallSection } from './wall-section-edit.js';

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
  | {
      readonly kind: 'linear'; readonly length: number; readonly width: number; readonly cross: number;
      /** A picker section (I, L, hollow, ...): its outer size follows its own dimensions (`setElementProfile`), not XDim / YDim. */
      readonly profiled: boolean;
    };

export function readElementSizeInStore(target: EditTarget, expressId: number): ElementSize | null {
  const scale = getModelLengthUnitScale(target.dataStore);
  const slab = resolveSlabEditChain(target.dataStore, target.view, target.editor, expressId, scale);
  // A slab is only edited as a flat extrusion of its outline (see setSlabThickness).
  if (slab) return slab.baseElevation === null ? null : { kind: 'slab', thickness: slab.thickness };
  const linear = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  return linear ? { kind: 'linear', length: linear.depth, width: linear.profileWidth, cross: linear.profileHeight, profiled: linear.profile !== null } : null;
}

const positive = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value > 0);

/** Caller owns the atomic transaction; refusal must roll back all prior writes. */
export function setElementSizeInStore(target: EditTarget, expressId: number, patch: ElementSizePatch): ElementSizeOutcome {
  if (patch.kind === 'wall') return setWallSectionInStore(target, expressId, patch);
  return patch.kind === 'slab'
    ? setSlabThickness(target, expressId, patch.thickness)
    : setLinearSize(target, expressId, patch);
}

function setSlabThickness(target: EditTarget, expressId: number, thickness: number): ElementSizeOutcome {
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
  const ownership = editOwnershipRefusal(target.dataStore, target.view, updates.map(update => update.entityId), expandAffectedSet(target.dataStore, target.view, [expressId], 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  for (const update of updates) target.editor.setPositionalAttribute(update.entityId, update.index, update.value);
  return { ok: true, remesh };
}

function setLinearSize(
  target: EditTarget,
  expressId: number,
  size: Extract<ElementSizePatch, { kind: 'linear' }>,
): ElementSizeOutcome {
  if (![size.length, size.width, size.cross].every(positive)) return { ok: false, reason: 'Length and section sizes must be greater than zero' };
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (!chain) return { ok: false, reason: 'This element is not a straight extrusion of a rectangle, so its size cannot be edited here' };
  // A profiled section has no XDim / YDim at attributes 3 and 4 (an I's are OverallWidth and OverallDepth, an L's Depth and Width):
  // its sides are edited as the section's own dimensions (`setElementProfile`), never here.
  if (chain.profile !== null && (size.width !== undefined || size.cross !== undefined)) {
    return { ok: false, reason: 'This element has a profiled section: change its dimensions in the Profile section' };
  }
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
  const ownership = editOwnershipRefusal(target.dataStore, target.view, updates.map(update => update.entityId), expandAffectedSet(target.dataStore, target.view, [expressId], 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  for (const update of updates) target.editor.setPositionalAttribute(update.entityId, update.index, update.value);
  return { ok: true, remesh: updates.length > 0 ? [expressId] : [] };
}
