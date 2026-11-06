/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { measureCameraState, sameMeasureCameraPose, type MeasureCameraState } from './measureCameraState.js';

/** Where a pointer move last drew the Measure preview: the rubber band, or Point mode's hover. */
export interface MeasureCursor {
  x: number;
  y: number;
  /** The rubber band followed Shift's orthogonal constraint. */
  orthogonal: boolean;
}

/** Per canvas, keyed by its stable frame ref, with the view the cursor was noted under. */
const cursors = new WeakMap<object, MeasureCursor & { view: MeasureCameraState }>();

/**
 * Noted by the preview's own move handlers; forgotten by any other Measure
 * move (a navigation press), a gesture reset and a touch tap, so turning Snap
 * off re-picks the preview only where it still follows the cursor (#8992). The
 * cursor leaving the canvas keeps it: the rubber band stays drawn there while
 * the cursor reaches the toolbar's Snap toggle, and Point mode drops its Live
 * reading on leave anyway.
 */
export function noteMeasureCursor(ctx: MouseHandlerContext, cursor: MeasureCursor | null): void {
  if (cursor) cursors.set(ctx.measureRaycastFrameRef, { ...cursor, view: measureCameraState(ctx.camera, ctx.canvas, ctx) });
  else cursors.delete(ctx.measureRaycastFrameRef);
}

/**
 * The noted cursor, while a pick there still returns what it did: like Point
 * mode's Live reading, it holds only for the view and scene it was noted under
 * (#8828, #8886).
 */
export function measureCursor(ctx: MouseHandlerContext): MeasureCursor | null {
  const cursor = cursors.get(ctx.measureRaycastFrameRef);
  return cursor && sameMeasureCameraPose(cursor.view, measureCameraState(ctx.camera, ctx.canvas, ctx)) ? cursor : null;
}
