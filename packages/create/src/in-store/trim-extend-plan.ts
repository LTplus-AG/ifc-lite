/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computeWallJoin, reshapeWallAxis, wallBodyOutline, type WallJoinWall } from './wall-join.js';
import type { WallJoinRead } from './wall-join-read.js';
import { cutsOutside, type HostedCuts } from './edit/wall-hosted-cuts.js';
import { clickAlong, planReach, type ReachBoundary, type ReachMode, type ReachRefusal, type ReachTarget, type ReachPlan } from './edit/trim-extend-geometry.js';
import { MIN_WALL_SEGMENT_LENGTH } from './edit/wall-edit.js';
import { MIN_LINEAR_SEGMENT_LENGTH } from './edit/linear-element-edit.js';

type Vec2 = readonly [number, number];
export interface TrimAxisTarget {
  readonly kind: 'wall' | 'beam';
  readonly axis: ReachTarget;
  readonly wall: WallJoinRead | null;
}
export type TrimPlanRefusal = ReachRefusal | 'wallBody' | 'hostedUnreadable' | 'hosted' | 'join';
export type TrimAxisPlan =
  | (Extract<ReachPlan, { ok: true }> & { readonly wall: WallJoinWall | null; readonly joinKind: 'L' | 'T' | 'butt' | null })
  | { readonly ok: false; readonly reason: TrimPlanRefusal; readonly count?: number; readonly detail?: string };

/** Shared live policy: joins include physical cut faces; moving the start or
 * contracting the body requires every hosted cut to be readable and inside. */
export function planTrimAxis(
  target: TrimAxisTarget, boundary: ReachBoundary, mode: ReachMode, click: Vec2,
  boundaryWall: WallJoinWall | null, hosted: HostedCuts | null,
): TrimAxisPlan {
  const plan = planReach(target.axis, boundary, mode, clickAlong(target.axis, click),
    target.kind === 'wall' ? MIN_WALL_SEGMENT_LENGTH : MIN_LINEAR_SEGMENT_LENGTH, boundaryWall !== null && target.kind === 'wall');
  if (!plan.ok) return plan;
  if (target.kind === 'beam') return { ...plan, wall: null, joinKind: null };
  const read = target.wall;
  if (!read) return { ok: false, reason: 'wallBody' };
  try {
    let wall = reshapeWallAxis(read.wall, [plan.start[0], plan.start[1]], [plan.stop[0], plan.stop[1]]);
    let joinKind: 'L' | 'T' | 'butt' | null = null;
    if (boundaryWall) {
      const join = computeWallJoin(boundaryWall, wall);
      wall = join.b.wall;
      joinKind = join.kind;
    }
    const span = (body: WallJoinWall): [number, number] => {
      const [dx, dy] = target.axis.dir;
      const first = (body.start[0] - read.origin[0]) * dx + (body.start[1] - read.origin[1]) * dy;
      const { corners } = wallBodyOutline(body);
      return [first + Math.max(corners[0][0], corners[3][0]), first + Math.min(corners[1][0], corners[2][0])];
    };
    if (!hosted) return { ok: false, reason: 'hostedUnreadable', count: 1 };
    const previous = span(read.wall), next = span(wall);
    const contracts = next[0] > previous[0] + 1e-9 || next[1] < previous[1] - 1e-9;
    if ((plan.moved < 0 || contracts || (plan.end === 'start' && plan.moved !== 0)) && hosted.unreadable.length > 0)
      return { ok: false, reason: 'hostedUnreadable', count: hosted.unreadable.length };
    const outside = cutsOutside(hosted.cuts, next[0], next[1]);
    if (outside.length > 0) return { ok: false, reason: 'hosted', count: outside.length };
    return { ...plan, wall, joinKind };
  } catch (error) {
    return { ok: false, reason: 'join', detail: error instanceof Error ? error.message : String(error) };
  }
}
