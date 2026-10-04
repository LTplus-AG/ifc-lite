/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { readWallJoinRels, readWallJoinTarget, type WallJoinRead } from './wall-join-read.js';
import { reshapeWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { toNativeLength } from './anchor.js';
import { resolveWallEditChain, type WallEditChain } from './edit/wall-edit.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import type { EditTarget } from './edit/target.js';

type Vec3 = [number, number, number];
export type WallEditContext = EditTarget;
export type WallResizeOutcome = { ok: true; newLength: number; walls: number[] } | { ok: false; reason: string };
export interface WallResizeOptions { moveJoinedEnds?: boolean; }
export interface WallMetres {
  start: Vec3; end: Vec3; thickness: number; height: number;
  chain: WallEditChain | null; read: WallJoinRead | null;
}
export function readWallMetres(ctx: WallEditContext, expressId: number): WallMetres | null {
  // The chain reads in metres when given the model's scale (#6233).
  const scale = getModelLengthUnitScale(ctx.dataStore);
  const chain = resolveWallEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId, scale);
  const read = readWallJoinTarget(ctx.dataStore, ctx.view, expressId, scale);
  if (read) {
    const z = read.location[2] * scale;
    return { start: [...read.wall.start, z], end: [...read.wall.end, z], thickness: read.wall.thickness, height: read.height, chain, read };
  }
  if (!chain) return null;
  const start: Vec3 = [...chain.startCoordinates];
  const length = chain.wallLength;
  const [dx, dy, dz] = chain.refDirection;
  const end: Vec3 = [start[0] + dx * length, start[1] + dy * length, start[2] + dz * length];
  return { start, end, thickness: chain.thickness, height: chain.height, chain, read: null };
}

/** Caller owns an atomic transaction. Coordinates are storey-local IFC Z-up metres. */
export function resizeWallInStore(ctx: EditTarget, expressId: number, newStart: Vec3, newEnd: Vec3, options: WallResizeOptions = {}): WallResizeOutcome {
  if (![...newStart, ...newEnd].every(Number.isFinite)) return { ok: false, reason: 'Wall endpoints must be finite' };
  const wall = readWallMetres(ctx, expressId);
  if (!wall) return { ok: false, reason: 'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation' };
  const dx = newEnd[0] - newStart[0];
  const dy = newEnd[1] - newStart[1];
  const dz = newEnd[2] - newStart[2];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { ok: false, reason: 'Wall length must be greater than zero' };
  if (Math.abs(dz) > Math.max(1e-6 * length, 1e-9)) {
    return { ok: false, reason: 'Start and end must lie on the same storey plane' };
  }

  const { chain, read } = wall;
  const joined = read !== null && readWallJoinRels(ctx.dataStore, ctx.view, new Set([expressId])).length > 0;
  if (chain && (read === null || (read.plain && read.axisRepId === null && !joined))) {
    const unit = { lengthUnitScale: getModelLengthUnitScale(ctx.dataStore) };
    const n = (value: number) => toNativeLength(unit, value);
    const nativeLength = n(length);
    const updates = [
      { entityId: chain.startPointId, index: 0, value: [n(newStart[0]), n(newStart[1]), n(newStart[2])] },
      { entityId: chain.refDirectionId, index: 0, value: [dx / length, dy / length, 0] },
      { entityId: chain.profileId, index: 3, value: nativeLength },
      { entityId: chain.profileOriginPointId, index: 0, value: [nativeLength / 2, 0] },
    ];
    const ownership = editOwnershipRefusal(ctx.dataStore, ctx.view, updates.map(update => update.entityId), expandAffectedSet(ctx.dataStore, ctx.view, [expressId], 'hostsChanged'));
    if (ownership) return { ok: false, reason: ownership };
    for (const update of updates) ctx.editor.setPositionalAttribute(update.entityId, update.index, update.value);
    return { ok: true, newLength: length, walls: [expressId] };
  }

  const result = reshapeWallsInStore(ctx.editor, ctx.dataStore, resolveWallJoinAnchor(ctx.dataStore, ctx.view),
    [{ wallId: expressId, start: [newStart[0], newStart[1]], end: [newEnd[0], newEnd[1]] }], options);
  return { ok: true, newLength: length, walls: result.walls };
}
