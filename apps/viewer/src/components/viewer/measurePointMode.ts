/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's Point mode (#8770): one click reads a point's
 * coordinates, with no distance gesture.
 *
 * Hover and click both pick through `raycastForPolylinePoint`, the polyline
 * click's magnetic snap, so the live point the readout shows while hovering is
 * the point a click there would commit. Hover shares the snap glyph's
 * throttle, so it can trail a fast cursor; the click re-picks where it lands.
 * A touch tap reaches
 * {@link handlePointClick} through `handleMeasureClickAt`, the same as the
 * other click-driven modes.
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelMeasureRaycast, handleMeasureHover, raycastForPolylinePoint, syncMeasureScreenCoords } from './measureHandlers.js';
import { updateSnapViz } from './measurePick.js';
import { noteMeasureCursor } from './measureCursor.js';
import { getDefaultEdgeLockState } from '@/store/slices/measurementSlice';
import { viewportCaptureOwnsFrame, viewportPicksAwaitLiveFrame } from '@/lib/viewport-capture';

/** Point mode is live: the Measure tool is open in Point mode. A hover frame queued before a mode or tool switch lands as a no-op. */
function pointModeLive(): boolean {
  const s = useViewerStore.getState();
  return s.activeTool === 'measure' && s.measureMode === 'point';
}

/**
 * Pick through the polyline click's magnetic snap, without an edge lock: Point
 * mode never builds one (its hover replaces the lock-maintaining preview), so
 * a lock left by another mode must not bend this pick along an old edge. The
 * empty lock is passed in rather than cleared in the store, whose ref only
 * catches up on the next render.
 */
function pickPoint(ctx: MouseHandlerContext, x: number, y: number) {
  return raycastForPolylinePoint({ ...ctx, edgeLockStateRef: { current: getDefaultEdgeLockState() } }, x, y);
}

/** Place the last point. A miss keeps the previous point, as a polyline miss does, and ends a Live reading. */
export function handlePointClick(ctx: MouseHandlerContext, x: number, y: number): void {
  if (!pointModeLive()) return;
  noteMeasureCursor(ctx, null); // the placed point, not a Live one, is what the readout shows now (#9022)
  // The click's pick supersedes a trailing hover or a hover frame already
  // queued, either of which would turn the readout back to "Live" for the
  // spot just placed (#8828).
  cancelQueuedHover(ctx);
  const picked = pickPoint(ctx, x, y);
  if (!picked) {
    // The cancelled hover frame would have read this miss too: nothing is under the cursor now.
    ctx.setSnapTarget(null);
    updateSnapViz(ctx, null);
    useViewerStore.getState().setMeasurePointLive(null);
    return;
  }
  ctx.setSnapTarget(picked.snapTarget);
  useViewerStore.getState().placeMeasurePoint(picked.point);
}

/** One hover frame: preview the point a click here would place, or clear the preview on a miss. */
export function hoverMeasurePoint(ctx: MouseHandlerContext, x: number, y: number): void {
  if (!pointModeLive()) { heldBackHovers.delete(ctx.lastHoverSnapTimeRef); return; }
  // A pick now would read a capture's camera or clip, not the view the user
  // sees (#9031): read this spot once the live loop has drawn again.
  if (viewportPicksAwaitLiveFrame(ctx.renderer)) { deferHover(ctx, x, y); return; }
  heldBackHovers.delete(ctx.lastHoverSnapTimeRef);
  // A live point holds only for the view it was picked under: the camera
  // reprojection pass drops it on any camera or scene change (#8828, #8886).
  // Bring that pass up to this view first, so the next frame does not count
  // the view as moved since some older reading and drop the point just
  // picked; and before the snap glyph is set, since a pass that ends an older
  // Live clears the glyph with it (#8886).
  syncMeasureScreenCoords(ctx);
  const picked = pickPoint(ctx, x, y);
  ctx.setSnapTarget(picked?.snapTarget ?? null);
  updateSnapViz(ctx, picked?.snapTarget ?? null);
  useViewerStore.getState().setMeasurePointLive(picked?.point ?? null);
}

/** Trailing hover picks, one per canvas (keyed by its stable throttle ref). */
const trailingHover = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** Drop a pending trailing hover pick (a click, the canvas going away). */
function cancelTrailingHover(ctx: MouseHandlerContext): void {
  const timer = trailingHover.get(ctx.lastHoverSnapTimeRef);
  if (timer === undefined) return;
  clearTimeout(timer);
  trailingHover.delete(ctx.lastHoverSnapTimeRef);
}

/**
 * A pointer move in Point mode. Runs on the shared hover throttle, plus one
 * trailing pick at the end of a throttled window: the readout says "Live", so
 * a cursor that comes to rest inside the window must still get its own reading.
 */
export function hoverMeasurePointAt(ctx: MouseHandlerContext, x: number, y: number): void {
  cancelTrailingHover(ctx);
  // With the view this move reads under, as a rubber-band move notes it (#9022)
  syncMeasureScreenCoords(ctx);
  noteMeasureCursor(ctx, { x, y, orthogonal: false, view: ctx.lastCameraStateRef.current });
  const wait = ctx.HOVER_SNAP_THROTTLE_MS - (Date.now() - ctx.lastHoverSnapTimeRef.current);
  if (wait > 0) {
    armTrailingHover(ctx, x, y, wait);
    return;
  }
  handleMeasureHover(ctx, x, y, hoverMeasurePoint);
}

function armTrailingHover(ctx: MouseHandlerContext, x: number, y: number, wait: number): void {
  trailingHover.set(ctx.lastHoverSnapTimeRef, setTimeout(() => {
    trailingHover.delete(ctx.lastHoverSnapTimeRef);
    // A press since then owns the pointer (orbit, or the click's own pick).
    if (!ctx.mouseState.isDragging) hoverMeasurePointAt(ctx, x, y);
  }, wait));
}

/** Hover picks held back since the capture released the frame, per canvas (#9031). */
const heldBackHovers = new WeakMap<object, number>();
/** Like the loop's own live-frame retries: past a transient miss, a timer must not keep the GPU busy. */
const HOVER_RENDER_REQUESTS = 3;

/**
 * Retry a hover pick a capture held back (#9031). A trailing pick already
 * pending is for a later cursor position, so it stands. While the capture
 * holds the frame nothing is failing, and its release asks for a frame. After
 * that, ask the loop for the live frame a few times; a frame that keeps
 * failing ends the Live reading, which is for an older cursor position, and
 * the retry stays a timer until the live frame lands.
 */
function deferHover(ctx: MouseHandlerContext, x: number, y: number): void {
  const key = ctx.lastHoverSnapTimeRef;
  if (!viewportCaptureOwnsFrame(ctx.renderer)) {
    const deferrals = (heldBackHovers.get(key) ?? 0) + 1;
    heldBackHovers.set(key, deferrals);
    if (deferrals <= HOVER_RENDER_REQUESTS) ctx.renderer.requestRender();
    else if (deferrals === HOVER_RENDER_REQUESTS + 1) {
      // As a miss ends Live: the snap glyph goes with it.
      ctx.setSnapTarget(null);
      updateSnapViz(ctx, null);
      useViewerStore.getState().setMeasurePointLive(null);
    }
  }
  if (!trailingHover.has(key)) armTrailingHover(ctx, x, y, ctx.HOVER_SNAP_THROTTLE_MS);
}

/**
 * Drop a trailing hover pick and a hover or rubber-band frame already queued.
 * Shared by a gesture reset (`resetMeasurePress`, #8786), a Point click and the
 * cursor leaving the canvas (#8828).
 */
export function cancelQueuedHover(ctx: MouseHandlerContext): void {
  cancelTrailingHover(ctx);
  heldBackHovers.delete(ctx.lastHoverSnapTimeRef);
  cancelMeasureRaycast(ctx);
}

/** The cursor left the canvas: drop a queued hover frame and the preview, so the readout falls back to the last point. */
export function endMeasurePointHover(ctx: MouseHandlerContext): void {
  cancelQueuedHover(ctx);
  if (pointModeLive()) noteMeasureCursor(ctx, null); // no Live reading for a Snap toggle to re-pick (#9022)
  useViewerStore.getState().setMeasurePointLive(null);
}
