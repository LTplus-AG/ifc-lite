/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall thickness and height (charter #6232, M2.5): the Model inspector's
 * Dimensions edit for a rectangle-profile wall.
 *
 * A wall built by `addWallToStore` (or any wall of the same
 * `IfcRectangleProfileDef` → `IfcExtrudedAreaSolid` shape, see
 * `resolveWallEditChain`) is `YDim` thick and `Depth` high. The profile is
 * centred on the axis, so a new thickness grows both faces equally.
 *
 * Values cross this module in metres and are written in the model's length
 * unit. The positional writes land on the undo stack; the caller's
 * transaction tags them as one step and re-meshes the wall (and the openings
 * it rewrote, `remesh`).
 *
 * The wall's openings follow the change in the same write (#6232 C4): a
 * thicker wall lengthens the cuts that no longer span it, and a height that
 * would leave an opening above the wall is refused, so hosted openings stay
 * valid whichever way the size is edited (inspector, push / pull, layers).
 */

import { toNativeLength } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { heightRefusal, hostBodyExtent, openingsOf, planCutRefit, type PositionalUpdate } from '@/lib/hosted-opening-refit.js';
import { readWallMetres } from './mutation-wall-resize.js';
import { modelEditTarget } from './mutation-modelling-records.js';

export interface WallSection {
  /** Metres across the wall. */
  readonly thickness?: number;
  /** Metres from the wall's base up. */
  readonly height?: number;
}

export type WallSectionOutcome =
  | { ok: true; /** Express ids whose mesh the write changed: the wall and the openings it re-cut. */ remesh: number[] }
  | { ok: false; reason: string };

/** IfcRectangleProfileDef.YDim and IfcExtrudedAreaSolid.Depth. */
const PROFILE_YDIM = 4;
const EXTRUSION_DEPTH = 3;

export function setWallSection(get: () => ViewerState, modelId: string, expressId: number, section: WallSection): WallSectionOutcome {
  for (const value of [section.thickness, section.height]) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) return { ok: false, reason: 'Wall thickness and height must be greater than zero' };
  }
  const target = modelEditTarget(get(), modelId);
  const wall = target ? readWallMetres(target, expressId) : null;
  if (!target || !wall) {
    return { ok: false, reason: 'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation' };
  }
  const scale = getModelLengthUnitScale(target.dataStore);
  const unit = { lengthUnitScale: scale };
  const updates: PositionalUpdate[] = [];
  const remesh = [expressId];
  if (section.thickness !== undefined && section.thickness !== wall.thickness) {
    const thickness = toNativeLength(unit, section.thickness);
    updates.push({ entityId: wall.chain.profileId, index: PROFILE_YDIM, value: thickness });
    if (openingsOf(target, expressId).length > 0) {
      // The profile is centred on the wall's axis, so its faces stay symmetric about the body's centre.
      const body = hostBodyExtent(target, expressId);
      if (!body) return { ok: false, reason: "This wall's body can't be read, so its openings can't follow the new thickness" };
      const centre = (body.min[1] + body.max[1]) / 2;
      const refit = planCutRefit(target, expressId, 1, [centre - thickness / 2, centre + thickness / 2], scale);
      if (!refit.ok) return refit;
      updates.push(...refit.updates);
      remesh.push(...refit.openings);
    }
  }
  if (section.height !== undefined && section.height !== wall.height) {
    const height = toNativeLength(unit, section.height);
    const refusal = heightRefusal(target, expressId, height, scale);
    if (refusal) return { ok: false, reason: refusal };
    updates.push({ entityId: wall.chain.extrudedSolidId, index: EXTRUSION_DEPTH, value: height });
  }
  get().setPositionalAttributesBatch(modelId, updates);
  return { ok: true, remesh };
}
