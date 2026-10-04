/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength } from './anchor.js';
import { readWallJoinTarget } from './wall-join-read.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { reanchorHostedOpeningsInStore } from './hosted-placement-edit.js';
import { resizeWallInStore } from './wall-size-edit.js';
import { resolveLinearElementChain } from './edit/linear-element-edit.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { readHostedCuts } from './edit/wall-hosted-cuts.js';
import { planTrimAxis } from './trim-extend-plan.js';
import type { ReachBoundary, ReachMode } from './edit/trim-extend-geometry.js';

export interface ElementTrimExtendParams {
  readonly mode: ReachMode;
  /** Storey-local plan click selecting which end is removed or extended. */
  readonly click: [number, number];
  /** Wall boundary is resolved live and joined; explicit lines cover slab
   * edges and snap guides in the existing command's storey frame. */
  readonly boundary: { readonly wallId: number } | ReachBoundary;
}
export interface ElementTrimExtendResult {
  readonly expressId: number;
  readonly walls: number[];
  readonly joined: boolean;
  readonly op: ReachMode;
  readonly end: 'start' | 'end';
  readonly length: number;
}

/** #6232 D5: live planning, resize, hosted refit and boundary join commit as
 * one atomic edit. No UI-only write path can diverge from this operation. */
export function trimExtendElementInStore(store: IfcDataStore, editor: StoreEditor, id: number, params: ElementTrimExtendParams): ElementTrimExtendResult {
  if (params.mode !== 'trim' && params.mode !== 'extend') throw new Error('Trim/extend mode must be trim or extend');
  if (params.click.length !== 2 || !params.click.every(Number.isFinite)) throw new Error('Trim/extend click must be finite');
  return editor.runAtomic(draft => {
    const view = draft.getMutationView(), scale = getModelLengthUnitScale(store);
    const type = draft.getEntityType(id)?.toUpperCase();
    const isWall = type === 'IFCWALL' || type === 'IFCWALLSTANDARDCASE';
    if (!isWall && type !== 'IFCBEAM' && type !== 'IFCMEMBER') throw new Error('Trim/extend requires a wall, beam or member');
    const storeyId = effectiveStoreyId(store, view, id);
    if (storeyId === undefined) throw new Error('Trim/extend requires a live storey');
    const read = isWall ? readWallJoinTarget(store, view, id, scale) : null;
    const chain = isWall ? null : resolveLinearElementChain(store, view, draft, id, scale);
    if ((isWall && !read) || (!isWall && !chain)) throw new Error('Trim/extend body cannot be read safely');
    const axis = read ? (() => {
      const { start, end } = read.wall, length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      return { p0: [start[0], start[1], read.location[2] * scale] as [number, number, number],
        dir: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, 0] as [number, number, number], length };
    })() : { p0: chain!.startCoordinates, dir: chain!.axisDirection, length: chain!.depth };
    let boundary: ReachBoundary, boundaryWall = null;
    if ('wallId' in params.boundary) {
      if (isWall && (String(store.schemaVersion ?? 'IFC4').toUpperCase() === 'IFC5' || !store.source || store.source.byteLength === 0))
        throw new Error('Wall joins are authored in IFC2X3, IFC4 and IFC4X3 models only');
      const boundaryId = params.boundary.wallId;
      if (boundaryId === id || effectiveStoreyId(store, view, boundaryId) !== storeyId) throw new Error('Boundary wall must be distinct and in the same live storey');
      const other = readWallJoinTarget(store, view, boundaryId, scale);
      if (!other) throw new Error('Boundary wall cannot be read safely');
      boundaryWall = other.wall;
      boundary = { a: other.wall.start, b: other.wall.end, tMin: 0, tMax: 1, reach: other.wall.thickness / 2 };
    } else {
      boundary = params.boundary;
      if (boundary.a.length !== 2 || boundary.b.length !== 2 || ![...boundary.a, ...boundary.b, boundary.reach].every(Number.isFinite)
        || Number.isNaN(boundary.tMin) || Number.isNaN(boundary.tMax) || boundary.tMin > boundary.tMax || boundary.reach < 0)
        throw new Error('Trim/extend boundary must be a valid finite plan line');
    }
    const hosted = read ? readHostedCuts(store, view, id) : null;
    const plan = planTrimAxis({ kind: isWall ? 'wall' : 'beam', axis, wall: read }, boundary, params.mode, params.click, boundaryWall, hosted);
    if (!plan.ok) throw new Error(`Trim/extend refused: ${plan.reason}${plan.detail ? `: ${plan.detail}` : ''}`);
    const walls = new Set<number>([id]);
    if (read) {
      const result = resizeWallInStore({ dataStore: store, view, editor: draft }, id, plan.start, plan.stop);
      if (!result.ok) throw new Error(result.reason);
      for (const wall of result.walls) walls.add(wall);
      const after = readWallJoinTarget(store, view, id, scale);
      if (hosted!.cuts.length > 0 && !after) throw new Error('Changed wall body cannot be read safely');
      if (after && hosted!.cuts.length > 0) {
        const [dx, dy] = axis.dir;
        const mx = after.origin[0] - read.origin[0], my = after.origin[1] - read.origin[1];
        const along = mx * dx + my * dy, across = -mx * dy + my * dx;
        if (Math.abs(along) > 1e-9 || Math.abs(across) > 1e-9)
          reanchorHostedOpeningsInStore(store, draft, id, [toNativeLength({ lengthUnitScale: scale }, along), toNativeLength({ lengthUnitScale: scale }, across), 0]);
      }
      if ('wallId' in params.boundary) {
        joinWallsInStore(draft, store, resolveWallJoinAnchor(store, view), params.boundary.wallId, id);
        walls.add(params.boundary.wallId);
      }
    } else {
      const writtenIds = [chain!.extrudedSolidId, ...(plan.end === 'start' ? [chain!.startPointId] : [])];
      const ownership = editOwnershipRefusal(store, view, writtenIds, new Set([id]));
      if (ownership) throw new Error(ownership);
      draft.setPositionalAttribute(chain!.extrudedSolidId, 3, toNativeLength({ lengthUnitScale: scale }, plan.length));
      if (plan.end === 'start') draft.setPositionalAttribute(chain!.startPointId, 0, plan.start.map(v => toNativeLength({ lengthUnitScale: scale }, v)));
    }
    return { expressId: id, walls: [...walls], joined: isWall && 'wallId' in params.boundary, op: plan.op, end: plan.end, length: plan.length };
  });
}
