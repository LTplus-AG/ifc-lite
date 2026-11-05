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
import { handleMeasureHover, raycastForPolylinePoint, syncMeasureScreenCoords } from './measureHandlers.js';
import { updateSnapViz } from './measurePick.js';
import { getDefaultEdgeLockState } from '@/store/slices/measurementSlice';

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
  // The click's pick supersedes a trailing hover or a hover frame already
  // queued, either of which would turn the readout back to "Live" for the
  // spot just placed (#8828).
  cancelQueuedHover(ctx);
  const picked = pickPoint(ctx, x, y);
  if (!picked) {
    // The cancelled hover frame would have read this miss too: nothing is under the cursor now.
    useViewerStore.getState().setMeasurePointLive(null);
    return;
  }
  ctx.setSnapTarget(picked.snapTarget);
  useViewerStore.getState().placeMeasurePoint(picked.point);
}

/** One hover frame: preview the point a click here would place, or clear the preview on a miss. */
export function hoverMeasurePoint(ctx: MouseHandlerContext, x: number, y: number): void {
  if (!pointModeLive()) return;
  const picked = pickPoint(ctx, x, y);
  ctx.setSnapTarget(picked?.snapTarget ?? null);
  updateSnapViz(ctx, picked?.snapTarget ?? null);
  // A live point holds only for the camera it was picked under: the camera
  // reprojection pass drops it on any camera change (#8828). Bring that pass
  // up to this camera first, so the next frame does not count the camera as
  // moved since some older reading and drop the point just picked.
  if (picked) syncMeasureScreenCoords(ctx);
  useViewerStore.getState().setMeasurePointLive(picked?.point ?? null);
}

/** Trailing hover picks, one per canvas (keyed by its stable throttle ref). */
const trailingHover = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** Drop a pending trailing hover pick (a click, the canvas going away). */
export function cancelTrailingHover(ctx: MouseHandlerContext): void {
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
  const wait = ctx.HOVER_SNAP_THROTTLE_MS - (Date.now() - ctx.lastHoverSnapTimeRef.current);
  if (wait > 0) {
    trailingHover.set(ctx.lastHoverSnapTimeRef, setTimeout(() => {
      trailingHover.delete(ctx.lastHoverSnapTimeRef);
      // A press since then owns the pointer (orbit, or the click's own pick).
      if (!ctx.mouseState.isDragging) hoverMeasurePointAt(ctx, x, y);
    }, wait));
    return;
  }
  handleMeasureHover(ctx, x, y, hoverMeasurePoint);
}

/** Drop a trailing hover pick and a hover frame already queued. */
function cancelQueuedHover(ctx: MouseHandlerContext): void {
  cancelTrailingHover(ctx);
  if (ctx.measureRaycastFrameRef.current !== null) {
    cancelAnimationFrame(ctx.measureRaycastFrameRef.current);
    ctx.measureRaycastFrameRef.current = null;
    ctx.measureRaycastPendingRef.current = false;
  }
}

/** The cursor left the canvas: drop a queued hover frame and the preview, so the readout falls back to the last point. */
export function endMeasurePointHover(ctx: MouseHandlerContext): void {
  cancelQueuedHover(ctx);
  useViewerStore.getState().setMeasurePointLive(null);
}
