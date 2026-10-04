/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { readWallJoinRels } from './wall-join-read.js';
import { reshapeWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { toNativeLength } from './anchor.js';
import { heightRefusal, hostBodyExtent, openingsOf, planCutRefit, type PositionalUpdate } from './edit/hosted-opening-refit.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { readWallMetres } from './wall-size-edit.js';
import type { EditTarget } from './edit/target.js';

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

export function setWallSectionInStore(target: EditTarget, expressId: number, section: WallSection): WallSectionOutcome {
  for (const value of [section.thickness, section.height]) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) return { ok: false, reason: 'Wall thickness and height must be greater than zero' };
  }
  const wall = readWallMetres(target, expressId);
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
      const reshaped = reshapeWallsInStore(target.editor, target.dataStore, resolveWallJoinAnchor(target.dataStore, target.view), [{ wallId: expressId, thickness: section.thickness }], {});
      remesh.push(...reshaped.walls);
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
  const ownership = editOwnershipRefusal(target.dataStore, target.view, updates.map(update => update.entityId), expandAffectedSet(target.dataStore, target.view, [expressId], 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  for (const update of updates) target.editor.setPositionalAttribute(update.entityId, update.index, update.value);
  return { ok: true, remesh: [...new Set(remesh)] };
}
