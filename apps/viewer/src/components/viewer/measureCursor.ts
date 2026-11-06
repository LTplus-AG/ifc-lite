/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import type { MeasureCameraState } from './measureCameraState.js';

/** Where a pointer move last drew the Measure preview: the rubber band, or Point mode's hover. */
export interface MeasureCursor {
  x: number;
  y: number;
  /** The rubber band followed Shift's orthogonal constraint. */
  orthogonal: boolean;
  /**
   * The rubber band's: the state the animation loop's reprojection pass last
   * ran for when the cursor was noted (`lastCameraStateRef`), so a re-pick
   * happens only while the pass still holds it, as Point's Live reading does
   * (#8828, #8886). Point notes none: the pass ends its Live on a view change.
   */
  view: MeasureCameraState | null;
}

/** Per canvas, keyed by its stable frame ref. */
const cursors = new WeakMap<object, MeasureCursor>();

/**
 * Noted by the preview's own move handlers; forgotten by every pointer move
 * first (`routeMousePointers`), a Distance start, a gesture reset and a touch tap, so a Snap
 * toggle re-picks the preview only where it still follows the cursor (#8992, #9022). The
 * cursor leaving the canvas keeps it: the rubber band stays drawn there while
 * the cursor reaches the toolbar's Snap toggle, and Point mode drops its Live
 * reading on leave anyway. So does a navigation press's move within its click
 * slop, which has not panned or orbited; a fly look under it turns the view,
 * which the re-pick's view check catches.
 */
export function noteMeasureCursor(ctx: Pick<MouseHandlerContext, 'measureRaycastFrameRef'>, cursor: MeasureCursor | null): void {
  if (cursor) cursors.set(ctx.measureRaycastFrameRef, cursor);
  else cursors.delete(ctx.measureRaycastFrameRef);
}

/** Shift pressed or released with the cursor at rest: a move there would follow the axis or leave it, so the re-pick does too (#9022). */
export function noteMeasureShift(ctx: Pick<MouseHandlerContext, 'measureRaycastFrameRef' | 'measurementConstraintEdgeRef'>, held: boolean): void {
  const cursor = measureCursor(ctx);
  if (cursor) cursors.set(ctx.measureRaycastFrameRef, { ...cursor, orthogonal: held && !!ctx.measurementConstraintEdgeRef.current });
}

export function measureCursor(ctx: Pick<MouseHandlerContext, 'measureRaycastFrameRef'>): MeasureCursor | null {
  return cursors.get(ctx.measureRaycastFrameRef) ?? null;
}
