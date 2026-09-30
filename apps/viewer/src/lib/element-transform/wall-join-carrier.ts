/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walls joined to a moved or turned wall follow it (charter #6232, B2): the
 * `TransformJoinCarrier` `commitElementTransform` calls in the same
 * transaction, after the roots are written.
 *
 * A moved wall keeps its placement, body and Axis (they move rigidly), so what
 * is left to write is its neighbours. A wall joined to it end to end (an L
 * corner or a butt) has its joined end taken to the moved wall's new end; a
 * wall that ENDS ON the moved wall's path keeps its place along that path, so
 * it is taken to where that point went. Then every join the moved wall is part
 * of is cut again. A wall the moved wall ends on stays where it is: the join
 * holds while the moved wall's end still lands on it and is removed when it
 * does not. Walls that move together (the whole room selected) keep their
 * joins as they are.
 *
 * Walls whose placement does not hang directly from the storey are not
 * carried: their coordinates are not the storey's.
 */

import { readWallJoinRels, readWallJoinTarget, type WallReshape } from '@ifc-lite/create';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { reshapeWallsIn, wallJoinRefusal } from '@/store/slices/mutation-wall-joins';
import type { TransformJoinCarrier } from './commit.js';

type Vec2 = [number, number];

/** The parent placement is the storey's own: wall coordinates are storey-local. */
const underStorey = (parent: { origin: Vec2; axis: Vec2 }): boolean =>
  parent.origin[0] === 0 && parent.origin[1] === 0 && parent.axis[0] === 1 && parent.axis[1] === 0;

export const carryWallJoins: TransformJoinCarrier = ({ tx, modelId, plan, op }) => {
  const state = tx.store;
  const target = modelEditTarget(state, modelId);
  if (!target || wallJoinRefusal(state, modelId) !== null) return [];
  const { dataStore, view } = target;
  const scale = getModelLengthUnitScale(dataStore);
  const rigid = new Set([...plan.roots.map((r) => r.expressId), ...plan.carried]);
  const turn = op.kind === 'rotate' ? op.angle : 0;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];

  const edits = new Map<number, WallReshape>();
  const refresh: number[] = [];
  for (const root of plan.roots) {
    if (!underStorey(root.parent)) continue;
    const moved = readWallJoinTarget(dataStore, view, root.expressId, scale);
    if (!moved) continue;
    // Where a point of the wall went: the wall's placement turned by `turn` about its own origin, then moved.
    const carried = (p: Vec2): Vec2 => {
      const dx = p[0] - root.origin[0];
      const dy = p[1] - root.origin[1];
      return [moved.origin[0] + cos * dx - sin * dy, moved.origin[1] + sin * dx + cos * dy];
    };
    const rels = readWallJoinRels(dataStore, view, new Set([root.expressId]));
    let checked = false;
    for (const rel of rels) {
      const own = rel.relatingId === root.expressId;
      const otherId = own ? rel.relatedId : rel.relatingId;
      const [ownConnection, otherConnection] = own
        ? [rel.relatingConnection, rel.relatedConnection]
        : [rel.relatedConnection, rel.relatingConnection];
      if (rigid.has(otherId)) continue;
      // A join with a wall that stays is checked against the new place, whichever wall ends on which.
      checked = true;
      if (otherConnection === 'ATPATH') continue;
      const other = readWallJoinTarget(dataStore, view, otherId, scale);
      if (!other) continue;
      const end = otherConnection === 'ATSTART' ? 'start' : 'end';
      const joint: Vec2 = ownConnection === 'ATPATH'
        ? carried(other.wall[end])
        : ownConnection === 'ATSTART' ? moved.wall.start : moved.wall.end;
      edits.set(otherId, { ...edits.get(otherId), wallId: otherId, [end]: joint });
    }
    if (checked) refresh.push(root.expressId);
  }
  if (refresh.length === 0) return [];
  const outcome = reshapeWallsIn(tx.api, modelId, [...edits.values()], { refresh }, tx.batchId);
  if (!outcome.ok) throw new Error(`Couldn't carry the joined walls: ${outcome.reason}`);
  return outcome.walls.filter((id) => !rigid.has(id));
};
