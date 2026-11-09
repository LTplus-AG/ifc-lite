/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { getDefaultEdgeLockState } from '@/store/slices/measurementSlice';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelMeasureRaycast, moveRubberBand, syncMeasureScreenCoords } from './measureHandlers.js';
import { hoverMeasurePoint } from './measurePointMode.js';
import { measureCursor, type MeasureCursor } from './measureCursor.js';
import { flySpeedStore } from './flySpeedStore.js';
import { viewportPicksAwaitLiveFrame } from '@/lib/viewport-capture';

/**
 * Snap turned off or back on in the Measure tool. A queued hover or rubber-band
 * frame would pick under the old setting (with Snap off, re-lock the edge,
 * #8881), so it is dropped. The live preview it would have refreshed, Point
 * mode's Live reading or the Distance rubber-band end, is then re-picked once
 * under the new setting where a move last drew it, through that move's own
 * pick (#8992, #9022). A pending Distance start and the gesture epoch stay.
 * With no preview following the cursor (none shown, a navigation drag, a new
 * start or a touch gesture since, a view or scene change since) nothing is
 * re-picked. A press alone moves neither the view nor the cursor, so the pick
 * under it is the one a move there would give.
 */
export function measureSnapToggle(ctx: MouseHandlerContext, snap: boolean): void {
  cancelMeasureRaycast(ctx);
  const cursor = cursorToRepick(ctx, !snap);
  // The refs catch up with the store only on the next render: pick under the new setting, with no lock to
  // slide along (a lock built with Snap on is stale, and Snap off builds none).
  if (cursor) repickAt(ctx, cursor, { ...ctx, snapEnabledRef: { current: snap }, edgeLockStateRef: { current: getDefaultEdgeLockState() } });
}

/**
 * Shift pressed or released with the cursor at rest (window keydown, keyup, or
 * a blur, `setMeasureContext`). The cursor record follows it, so a Snap
 * toggle's re-pick does too (#9022), and the Distance rubber band is re-picked
 * there now, as a move with that Shift state would draw it, axis highlight
 * included (#9161). A queued rubber-band frame is dropped by the re-pick;
 * with no re-pick it reads the updated Shift state when it runs (#9242). Point
 * mode's pick ignores Shift: its record changes in place, which keeps a queued
 * trailing hover valid.
 */
export function measureShiftChange(ctx: MouseHandlerContext, held: boolean): void {
  const cursor = measureCursor(ctx);
  const orthogonal = held && !!ctx.measurementConstraintEdgeRef.current;
  // A key held down repeats its keydown
  if (!cursor || cursor.orthogonal === orthogonal) return;
  cursor.orthogonal = orthogonal;
  // A command's preview frame is its own
  if (flySpeedStore.get().active || ctx.activeToolRef.current !== 'measure' || useViewerStore.getState().measureMode === 'point') return;
  // Snap did not change, but its ref and the lock's may still lag a toggle's store update by a render
  const { snapEnabled: snap, edgeLockState } = useViewerStore.getState();
  if (!cursorToRepick(ctx, snap)) return;
  cancelMeasureRaycast(ctx);
  repickAt(ctx, cursor, { ...ctx, snapEnabledRef: { current: snap }, edgeLockStateRef: { current: edgeLockState } });
}

/**
 * The noted cursor, if the preview there still follows it and the view it was
 * noted under still holds. `passSnap` is Snap as the last frame's reprojection
 * pass saw it.
 */
function cursorToRepick(ctx: MouseHandlerContext, passSnap: boolean): MeasureCursor | null {
  const cursor = measureCursor(ctx);
  if (!cursor?.view) return null;
  const point = useViewerStore.getState().measureMode === 'point';
  if (!point && !useViewerStore.getState().activeMeasurement) return null;
  // A pick now would read a capture's camera or clip (#9031). Point's hover holds itself back until the
  // live frame; the rubber band waits for the next move.
  if (!point && viewportPicksAwaitLiveFrame(ctx.renderer)) return null;
  // The animation loop's pass ends Point's Live and replaces the noted state on any view or scene change
  // (#8886, #8998), and the canvas box watch clears that state. Run it now, as the last frame saw Snap, so
  // a change since that frame counts too; the input that re-picks reaches the pass only on the next frame.
  syncMeasureScreenCoords({ ...ctx, snapEnabledRef: { current: passSnap } });
  return cursor.view === ctx.lastCameraStateRef.current ? cursor : null;
}

/** Re-pick the live preview at `cursor` through `picking`, through the move's own pick. */
function repickAt(ctx: MouseHandlerContext, cursor: MeasureCursor, picking: MouseHandlerContext): void {
  const point = useViewerStore.getState().measureMode === 'point';
  // Bring the pass up to the picking setting first (the Point hover does so itself), so the next frame keeps
  // its state and the next toggle still finds the cursor's view current.
  if (point) hoverMeasurePoint(picking, cursor.x, cursor.y);
  else {
    syncMeasureScreenCoords(picking);
    moveRubberBand(picking, cursor.x, cursor.y, cursor.orthogonal);
  }
  // In place, as Shift is noted: a Point retry the re-pick armed (a capture holding the frame, #9031) keeps its record
  cursor.view = ctx.lastCameraStateRef.current;
}
