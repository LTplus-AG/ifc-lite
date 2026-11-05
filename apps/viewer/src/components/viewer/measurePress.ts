/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the last placed Measure vertex was pressed, so a press that snapping
 * pulls back onto it can be told apart from a double-click or a retap (#8788,
 * #8866). Shared by Distance's start and the Polyline, Angle and Radius
 * vertices, for clicks and taps alike.
 */

import type { MeasurePoint } from '@/store';
import type { MouseHandlerContext, MouseState } from './mouseHandlerTypes.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';
import { pickSurfacePoint } from './measurePick.js';
import { isDuplicateClickPoint } from './measureHandlers.js';

/**
 * Where the last vertex was pressed, before snapping, and where it showed then.
 * Matched to the vertex by world position: a camera move rebuilds the vertex object.
 */
const vertexPresses = new WeakMap<MouseState, { world: { x: number; y: number; z: number }; press: { x: number; y: number }; shown: { x: number; y: number } }>();
/** A press within this far (CSS px) of the last vertex's own press is that press repeated. */
const REPRESS_SLOP_PX = 8;

/** Record that `vertex` was placed by a press at `at`; no `at` (Shift axis, keyboard) forgets it. */
export function rememberVertexPress(ctx: MouseHandlerContext, vertex: MeasurePoint, at?: { x: number; y: number }): void {
  if (!at) {
    vertexPresses.delete(ctx.mouseState);
    return;
  }
  const { x, y, z, screenX, screenY } = vertex;
  vertexPresses.set(ctx.mouseState, { world: { x, y, z }, press: at, shown: { x: screenX, y: screenY } });
}

/**
 * The point a press at `at` places after `prev`. When snapping pulled it onto
 * `prev` (a vertex or edge both are near) but the press is clearly a new point,
 * that is the exact surface under the pointer instead, so the press is not
 * dropped. Otherwise `picked` unchanged: the caller's duplicate guard still
 * catches a double-click, a double-tap and a retap on `prev`.
 */
export function unsnapFromPrevious(ctx: MouseHandlerContext, prev: MeasurePoint, picked: MeasurePoint, at: { x: number; y: number }): MeasurePoint {
  if (!isDuplicateClickPoint(prev, picked) || !pressedAwayFrom(ctx, prev, at)) return picked;
  return pickSurfacePoint(ctx, at.x, at.y) ?? picked;
}

/**
 * Whether a press at `at` is clearly a new point: away from where `prev` was
 * pressed (so not a double-click or double-tap snapping to the same target) and
 * not on `prev` as it now shows (so not a retap on it after the camera moved).
 */
function pressedAwayFrom(ctx: MouseHandlerContext, prev: MeasurePoint, at: { x: number; y: number }): boolean {
  const record = vertexPresses.get(ctx.mouseState);
  if (!record || record.world.x !== prev.x || record.world.y !== prev.y || record.world.z !== prev.z) return false;
  const shown = projectToCssScreen(ctx.camera, ctx.canvas, prev) ?? { x: prev.screenX, y: prev.screenY };
  // The press moves on screen with the vertex when the camera does, so a repeated press still
  // counts after a small drift (inertia, a reprojection) as well as after none.
  const press = { x: record.press.x + shown.x - record.shown.x, y: record.press.y + shown.y - record.shown.y };
  const nearPress = Math.hypot(at.x - press.x, at.y - press.y) <= REPRESS_SLOP_PX;
  // A press on the shown vertex itself stays a retap, as the callers' duplicate guards have it.
  return !nearPress && !isDuplicateClickPoint({ screenX: shown.x, screenY: shown.y }, { screenX: at.x, screenY: at.y });
}
