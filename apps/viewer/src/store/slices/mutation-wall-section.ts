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
 * transaction tags them as one step and re-meshes the wall.
 *
 * A wall with joins, cut ends or an offset body gets its new thickness through
 * `reshapeWallsIn`: its body is rewritten and every join it is part of is cut
 * again for the new thickness, so the corners stay clean.
 *
 * The wall's openings follow the change in the same write (#6232 C4): a
 * thicker wall lengthens the cuts that no longer span it, and a height that
 * would leave an opening above the wall is refused, so hosted openings stay
 * valid whichever way the size is edited (inspector, push / pull, layers).
 * `remesh` names what the write changed: the wall and the openings it re-cut.
 */

import { readWallJoinRels, toNativeLength } from '@ifc-lite/create';
import { heightRefusal, hostBodyExtent, openingsOf, planCutRefit, type PositionalUpdate } from '@/lib/hosted-opening-refit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { readWallMetres } from './mutation-wall-resize.js';
import { modelEditTarget, type ModellingStore } from './mutation-modelling-records.js';
import { reshapeWallsIn } from './mutation-wall-joins.js';

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

export function setWallSection(store: ModellingStore, modelId: string, expressId: number, section: WallSection): WallSectionOutcome {
  const get = store.getState;
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
  // Refuse before writing anything: an opening the new height would leave above the wall.
  if (section.height !== undefined && section.height !== wall.height) {
    const refusal = heightRefusal(target, expressId, toNativeLength(unit, section.height), scale);
    if (refusal) return { ok: false, reason: refusal };
  }
  if (section.thickness !== undefined && section.thickness !== wall.thickness) {
    const thickness = toNativeLength(unit, section.thickness);
    const hosts = openingsOf(target, expressId).length > 0;
    // The profile is centred on the axis, so a plain wall's faces stay symmetric about the body's centre.
    const before = hosts ? hostBodyExtent(target, expressId) : null;
    if (hosts && !before) return { ok: false, reason: "This wall's body can't be read, so its openings can't follow the new thickness" };
    const joined = wall.read !== null && readWallJoinRels(target.dataStore, target.view, new Set([expressId])).length > 0;
    const plain = wall.chain !== null && (wall.read === null || (wall.read.plain && !joined));
    if (wall.chain && plain) {
      updates.push({ entityId: wall.chain.profileId, index: PROFILE_YDIM, value: thickness });
    } else {
      const reshaped = reshapeWallsIn(store, modelId, [{ wallId: expressId, thickness: section.thickness }], {});
      if (!reshaped.ok) return reshaped;
    }
    if (hosts) {
      // A reshape may have moved the body (an offset wall): span where it is now; a plain wall grows about its centre.
      const now = plain ? null : hostBodyExtent(target, expressId);
      const centre = (before!.min[1] + before!.max[1]) / 2;
      const extent: [number, number] = now ? [now.min[1], now.max[1]] : [centre - thickness / 2, centre + thickness / 2];
      const refit = planCutRefit(target, expressId, 1, extent, scale);
      if (!refit.ok) return refit;
      updates.push(...refit.updates);
      remesh.push(...refit.openings);
    }
  }
  if (section.height !== undefined && section.height !== wall.height) {
    // Read the wall again: a reshape above rewrote its body, so the ids read at entry may be stale.
    const solidId = readWallMetres(target, expressId)?.read?.solidId ?? wall.chain?.extrudedSolidId;
    if (solidId === undefined) return { ok: false, reason: 'The wall has no body extrusion to take a new height' };
    updates.push({ entityId: solidId, index: EXTRUSION_DEPTH, value: toNativeLength(unit, section.height) });
  }
  if (updates.length > 0 && get().setPositionalAttributesBatch(modelId, updates) === null) {
    return { ok: false, reason: 'The wall size could not be written' };
  }
  return { ok: true, remesh };
}
