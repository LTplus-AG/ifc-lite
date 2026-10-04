/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWallJoinRels, readWallJoinTarget } from './wall-join-read.js';
import { reshapeWallsInStore, resolveWallJoinAnchor, type WallReshape } from './wall-join-edit.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import type { EditTarget } from './edit/target.js';
import type { TransformPlan } from './element-transform-plan.js';

type Vec2 = [number, number];

/** The parent placement is the storey's own: wall coordinates are storey-local. */
const underStorey = (parent: { origin: Vec2; axis: Vec2 }): boolean =>
  parent.origin[0] === 0 && parent.origin[1] === 0 && parent.axis[0] === 1 && parent.axis[1] === 0;

export function carryWallJoinsInStore(target: EditTarget, plan: TransformPlan, turn: number): readonly number[] {
  if (String(target.dataStore.schemaVersion).toUpperCase() === 'IFC5' || !target.dataStore.source?.byteLength) return [];
  const { dataStore, view } = target;
  const scale = getModelLengthUnitScale(dataStore);
  const rigid = new Set([...plan.roots.map((r) => r.expressId), ...plan.carried]);
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
  const outcome = reshapeWallsInStore(target.editor, dataStore, resolveWallJoinAnchor(dataStore, view), [...edits.values()], { refresh });
  return outcome.walls.filter((id) => !rigid.has(id));
};
