/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Splitting a wall that has joins, cut ends or an `Axis` representation
 * (#6232 B2). The plain split (`splitWall`) re-authors a bare rectangle from
 * its placement and XDim, which would leave a joined wall's axis stale and
 * lose its joins. Here the cut runs along the AXIS:
 *
 *  - the new piece is authored like any wall (`addWall`), the source is
 *    re-shaped onto the other piece (`reshapeWallsInStore`), both square at
 *    the cut;
 *  - each `IfcRelConnectsPathElements` of the source goes to the piece it
 *    belongs to: a corner at the wall's start to the first piece, at its end
 *    to the last, a T on its path to the piece the other wall ends on. A join
 *    that moves is removed and written again for the new piece, so its cuts
 *    are computed against the new wall.
 *
 * The rest of the split (openings, metadata, one undo batch) is `splitWall`'s.
 */

import {
  joinWallsInStore,
  readWallJoinRels,
  readWallJoinTarget,
  reshapeWallsInStore,
  resolveWallJoinAnchor,
  type WallJoinRead,
  type WallJoinRel,
} from '@ifc-lite/create';
import type { SplitEnv } from './mutation-split.js';
import type { ViewerState } from '../index.js';
import { keepsFirstPiece } from '@/lib/split-guid.js';
import { MIN_WALL_SEGMENT_LENGTH } from '@/lib/wall-edit.js';
import { recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';

/** A wall this split has to treat as a joined one: its joins, cuts or axis are more than the bare rectangle the plain split rewrites. */
export interface JoinAwareWall {
  read: WallJoinRead;
  rels: WallJoinRel[];
}

/** The join-aware inputs of `expressId`, or null when the plain split is enough. */
export function joinAwareWall(env: Pick<SplitEnv, 'dataStore' | 'view' | 'lengthUnitScale'>, expressId: number): JoinAwareWall | null {
  const read = readWallJoinTarget(env.dataStore, env.view, expressId, env.lengthUnitScale);
  if (!read) return null;
  const rels = readWallJoinRels(env.dataStore, env.view, new Set([expressId]));
  return read.plain && read.axisRepId === null && rels.length === 0 ? null : { read, rels };
}

export type JoinAwareSplit =
  | { ok: true; addedId: number; keepLeft: boolean }
  | { ok: false; reason: string };

/**
 * Cut `expressId` at `distance` metres from its placement origin along its
 * axis (the distance the Split tool projects the cursor to).
 */
export function splitJoinedWall(
  store: ModellingStore,
  env: SplitEnv,
  modelId: string,
  expressId: number,
  distance: number,
  { read, rels }: JoinAwareWall,
): JoinAwareSplit {
  const get: () => ViewerState = store.getState;
  const { start, end } = read.wall;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const dir: [number, number] = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  // `distance` counts from the placement origin; the axis may start a little past it.
  const fromStart = distance - ((start[0] - read.origin[0]) * dir[0] + (start[1] - read.origin[1]) * dir[1]);
  if (!Number.isFinite(distance) || !(fromStart > MIN_WALL_SEGMENT_LENGTH && fromStart < length - MIN_WALL_SEGMENT_LENGTH)) {
    return { ok: false, reason: `Split must be at least ${MIN_WALL_SEGMENT_LENGTH} m from each end (wall is ${length.toFixed(2)} m)` };
  }
  if (!Number.isFinite(read.height) || read.height <= 0) return { ok: false, reason: 'Wall has no readable extrusion height' };
  const cutPoint: [number, number] = [start[0] + dir[0] * fromStart, start[1] + dir[1] * fromStart];
  const keepLeft = keepsFirstPiece(fromStart, length - fromStart);
  const kept = keepLeft ? { start, end: cutPoint } : { start: cutPoint, end };
  const fresh = keepLeft ? { start: cutPoint, end } : { start, end: cutPoint };

  const z = read.location[2] * env.lengthUnitScale;
  const added = get().addWall(modelId, env.storeyExpressId, {
    Start: [fresh.start[0], fresh.start[1], z],
    End: [fresh.end[0], fresh.end[1], z],
    Thickness: read.wall.thickness,
    Height: read.height,
    ...(read.wall.offset === undefined ? {} : { Offset: read.wall.offset }),
    Name: env.name,
    GlobalId: env.newGlobalId,
  });
  if ('error' in added) return { ok: false, reason: added.error };

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

  try {
    recordModellingEdit(store, modelId, (_methods, draft) => {
      const anchor = resolveWallJoinAnchor(env.dataStore, draft.getMutationView());
      const moving = rels.filter(movesToNew);
      for (const rel of moving) draft.removeEntity(rel.relId);
      reshapeWallsInStore(draft, env.dataStore, anchor, [{ wallId: expressId, start: kept.start, end: kept.end }]);
      for (const rel of moving) {
        const [a, b] = rel.relatingId === expressId ? [added.expressId, rel.relatedId] : [rel.relatingId, added.expressId];
        joinWallsInStore(draft, env.dataStore, anchor, a, b, {
          priority: 'a',
          priorities: { a: rel.relatingPriorities, b: rel.relatedPriorities },
          Name: rel.name ?? undefined,
        });
      }
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, addedId: added.expressId, keepLeft };
}
