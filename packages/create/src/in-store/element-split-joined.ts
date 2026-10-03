/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWallJoinTarget, type WallJoinRead, type WallJoinRel } from './wall-join-read.js';
import { joinWallsInStore, reshapeWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { emitOrdinaryElement, type OrdinaryInStoreElement } from './ordinary-element.js';
import { keepsFirstPiece } from './edit/split-guid.js';
import { MIN_WALL_SEGMENT_LENGTH } from './edit/wall-edit.js';
import type { SplitEnvironment } from './element-split.js';
/**
 * Cut `expressId` at `distance` metres from its placement origin along its
 * axis (the distance the Split tool projects the cursor to).
 */
export function splitJoinedWallDraft(
  env: SplitEnvironment,
  expressId: number,
  distance: number,
  read: WallJoinRead,
  rels: WallJoinRel[],
): { addedId: number; keepLeft: boolean; element: OrdinaryInStoreElement } {
  const { start, end } = read.wall;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const dir: [number, number] = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  // `distance` counts from the placement origin; the axis may start a little past it.
  const fromStart = distance - ((start[0] - read.origin[0]) * dir[0] + (start[1] - read.origin[1]) * dir[1]);
  if (!Number.isFinite(distance) || !(fromStart > MIN_WALL_SEGMENT_LENGTH && fromStart < length - MIN_WALL_SEGMENT_LENGTH)) {
    throw new Error(`Split must be at least ${MIN_WALL_SEGMENT_LENGTH} m from each end (wall is ${length.toFixed(2)} m)`);
  }
  if (!Number.isFinite(read.height) || read.height <= 0) throw new Error('Wall has no readable extrusion height');
  const cutPoint: [number, number] = [start[0] + dir[0] * fromStart, start[1] + dir[1] * fromStart];
  const keepLeft = keepsFirstPiece(fromStart, length - fromStart);
  const kept = keepLeft ? { start, end: cutPoint } : { start: cutPoint, end };
  const fresh = keepLeft ? { start: cutPoint, end } : { start, end: cutPoint };

  const z = read.location[2] * env.lengthUnitScale;
  const element: OrdinaryInStoreElement = { kind: 'wall', params: {
    Start: [fresh.start[0], fresh.start[1], z],
    End: [fresh.end[0], fresh.end[1], z],
    Thickness: read.wall.thickness,
    Height: read.height,
    ...(read.wall.offset === undefined ? {} : { Offset: read.wall.offset }),
    Name: env.name,
    GlobalId: env.newGlobalId,
  } };
  const addedId = emitOrdinaryElement(env.editor, resolveSpatialAnchor(env.dataStore, env.storeyExpressId, env.view), element);

  // A join follows the piece its end (or, for a T, the joint on its path) is on.
  const alongAxis = (p: readonly [number, number]) => (p[0] - start[0]) * dir[0] + (p[1] - start[1]) * dir[1];
  const movesToNew = (rel: WallJoinRel): boolean => {
    const own = rel.relatingId === expressId ? rel.relatingConnection : rel.relatedConnection;
    let onSecond = own === 'ATEND';
    if (own === 'ATPATH') {
      const other = readWallJoinTarget(env.dataStore, env.view, rel.relatingId === expressId ? rel.relatedId : rel.relatingId, env.lengthUnitScale);
      const otherConnection = rel.relatingId === expressId ? rel.relatedConnection : rel.relatingConnection;
      const joint = other ? (otherConnection === 'ATSTART' ? other.wall.start : other.wall.end) : null;
      onSecond = joint !== null && alongAxis(joint) > fromStart;
    }
    // The source keeps the first piece when `keepLeft`: a join on the second piece moves to the new wall.
    return onSecond === keepLeft;
  };

  const draft = env.editor;
  {
      const anchor = resolveWallJoinAnchor(env.dataStore, draft.getMutationView());
      const moving = rels.filter(movesToNew);
      for (const rel of moving) draft.removeEntity(rel.relId);
      reshapeWallsInStore(draft, env.dataStore, anchor, [{ wallId: expressId, start: kept.start, end: kept.end }]);
      for (const rel of moving) {
        const [a, b] = rel.relatingId === expressId ? [addedId, rel.relatedId] : [rel.relatingId, addedId];
        joinWallsInStore(draft, env.dataStore, anchor, a, b, {
          priority: 'a',
          priorities: { a: rel.relatingPriorities, b: rel.relatedPriorities },
          Name: rel.name ?? undefined,
        });
      }
  }
  return { addedId, keepLeft, element };
}
