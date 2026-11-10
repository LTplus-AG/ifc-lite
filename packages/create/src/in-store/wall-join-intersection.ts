/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PlanPoint, WallConnectionType, WallJoinWall } from './wall-join.js';

/** Infinite plan lines, with a sine threshold rather than a length-dependent determinant. */
export function wallAxisIntersection(a: WallJoinWall, b: WallJoinWall): PlanPoint {
  const direction = (w: WallJoinWall): PlanPoint => {
    const length = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    if (!(length > 1e-6)) throw new Error('Cannot carry wall join: wall axis has no positive length');
    return [(w.end[0] - w.start[0]) / length, (w.end[1] - w.start[1]) / length];
  };
  const u = direction(a), v = direction(b);
  const cross = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(cross) < 1e-6) throw new Error('Cannot carry wall join along existing axes: parallel or degenerate intersection');
  const x = b.start[0] - a.start[0], y = b.start[1] - a.start[1];
  const t = (x * v[1] - y * v[0]) / cross;
  const point: PlanPoint = [a.start[0] + t * u[0], a.start[1] + t * u[1]];
  if (!point.every(Number.isFinite)) throw new Error('Cannot carry wall join: intersection is not finite');
  return point;
}

/** Preserve the original axis direction: an endpoint may not pass its opposite end. */
export function wallAtIntersection(wall: WallJoinWall, connection: WallConnectionType, point: PlanPoint): WallJoinWall {
  if (connection === 'ATPATH') return wall;
  const start = connection === 'ATSTART' ? point : wall.start;
  const end = connection === 'ATEND' ? point : wall.end;
  const dx = wall.end[0] - wall.start[0], dy = wall.end[1] - wall.start[1];
  const length = ((end[0] - start[0]) * dx + (end[1] - start[1]) * dy) / Math.hypot(dx, dy);
  if (!(length > 1e-6)) throw new Error('Cannot carry wall join along existing axes: intersection would collapse or reverse the wall');
  return { ...wall, start, end };
}
