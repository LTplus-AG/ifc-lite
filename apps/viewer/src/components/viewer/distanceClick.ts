/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Distance is click-click (#8771): the press/release state machine shared by
 * mouse clicks and touch taps. The first press sets the start, the rubber band
 * follows the pointer (measureHandlers.ts handleMeasureDrag), and the second
 * click, or a press dragged past the #8740 click slop, finishes.
 */

import { useViewerStore, type MeasurePoint } from '@/store';
import type { MouseHandlerContext, MouseState } from './mouseHandlerTypes.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';
import { IFC_AXIS_COLORS } from '@/lib/viewport-ui/overlay-theme';
import { measureSnapOptions, pickMeasurePoint } from './measurePick.js';
import { cancelQueuedHover } from './measurePointMode.js';
import { cancelMeasureRaycast, isDuplicateClickPoint, projectOntoConstraintAxis } from './measureHandlers.js';
import { forgetVertexPress, rememberVertexPress, unsnapFromPrevious } from './measurePress.js';
import { noteMeasureCursor } from './measureCursor.js';

/** Presses that set a distance start, so their release can tell a first click from a second (#8771). */
const startingPresses = new WeakSet<MouseState>();
/** The last press finished a distance; a start right after it may be a double-click's second press. */
const finishingPresses = new WeakSet<MouseState>();
/** The last press set a start right after a finish: a dblclick on it drops that start. */
const startsAfterFinish = new WeakSet<MouseState>();
/** The store's measure gesture epoch when each press (a mouse state, a touch state) began (#8786). */
const pressEpochs = new WeakMap<object, number>();

/**
 * A press began: a Measure gesture reset before its release makes it another
 * gesture's (#8786). A mouse press that is not a Measure tool press
 * (navigation, another tool) also breaks the finish-then-start chain.
 */
export function beginMeasurePress(press: object, measuring = true): void {
  pressEpochs.set(press, useViewerStore.getState().measureGestureEpoch);
  if (!measuring) forgetDistancePress(press as MouseState);
}

/**
 * Whether a Measure gesture reset (Esc, a mode or tool switch) came after this
 * press began, so its release or click must place nothing (#8786): the press
 * belongs to the gesture that was reset, not to the one now active.
 */
export function pressOutlivedReset(press: object): boolean {
  const began = pressEpochs.get(press);
  return began !== undefined && began !== useViewerStore.getState().measureGestureEpoch;
}

/**
 * The pointer side of a Measure gesture reset (#8786), run whenever the store's
 * `resetMeasureGesture` bumps the epoch: the queued raycast frame would set the
 * snap target, edge lock and glyph the reset just cleared, and this press
 * state's records belong to the gesture that is gone. The frame ref is shared
 * with the command tool's preview, so only a Measure frame is dropped.
 */
export function resetMeasurePress(ctx: MouseHandlerContext): void {
  if (ctx.activeToolRef.current === 'measure') cancelQueuedHover(ctx);
  startingPresses.delete(ctx.mouseState);
  forgetVertexPress(ctx);
  forgetDistancePress(ctx.mouseState);
  noteMeasureCursor(ctx, null); // the preview it followed is gone (#8992)
}

/** Set a distance start and its Shift axis triad. Shared by the first click and the first tap (#8771). */
export function beginDistance(ctx: MouseHandlerContext, measurePoint: MeasurePoint, at?: { x: number; y: number }): void {
  ctx.startMeasurement(measurePoint);
  rememberVertexPress(ctx, measurePoint, at);
  noteMeasureCursor(ctx, null); // an earlier gesture's cursor, as after a pen tap with no move between (#8992)

  // Set up orthogonal constraint for Shift - always use world axes
  ctx.setMeasurementConstraintEdge({
    axes: {
      axis1: { x: 1, y: 0, z: 0 },  // World X
      axis2: { x: 0, y: 1, z: 0 },  // World Y (vertical)
      axis3: { x: 0, y: 0, z: 1 },  // World Z
    },
    // Shared triad (#5490) by IFC meaning: renderer Y is IFC Z (up), renderer Z is IFC Y.
    colors: { axis1: IFC_AXIS_COLORS.x, axis2: IFC_AXIS_COLORS.z, axis3: IFC_AXIS_COLORS.y },
    activeAxis: null,
  });
  // The pick's edge lock belongs to continuous motion: a hover or drag re-acquires it on its next
  // frame, while a lock kept here would pull a second click or tap back onto the start.
  ctx.clearEdgeLock();
}

/**
 * Finish a pending distance at `end`: the second click or tap (#8771). A point
 * on top of the start (the second half of a double-click) is ignored, so it
 * cannot finish a zero-length measurement.
 */
export function finishDistance(ctx: MouseHandlerContext, end: MeasurePoint, at?: { x: number; y: number }): boolean {
  const active = ctx.activeMeasurementRef.current;
  if (!active) return false;
  // Finished or rejected, this pick's edge lock must not pull the next one (see beginDistance).
  ctx.clearEdgeLock();
  // Pressed away from the start but snapped back onto it (a vertex or edge both points are near):
  // measure to the exact surface under the pointer instead of dropping the press (#8788).
  if (at) end = unsnapFromPrevious(ctx, active.start, end, at);
  if (isDuplicateClickPoint(active.start, end)) return false;
  ctx.updateMeasurement(end);
  ctx.finalizeMeasurement();
  return true;
}

/** Any other press (navigation, another tool) breaks the finish-then-start chain a dblclick may drop. */
export function forgetDistancePress(mouseState: MouseState): void {
  finishingPresses.delete(mouseState);
  startsAfterFinish.delete(mouseState);
}

/**
 * Whether the pending start was set by the second press of a double-click that
 * finished a distance (#8771), so the dblclick should drop it. A start chained
 * from the previous end on purpose is a press of its own and does not qualify.
 */
export function takeDoubleClickStart(ctx: MouseHandlerContext): boolean {
  const stray = startsAfterFinish.has(ctx.mouseState) && ctx.activeMeasurementRef.current !== null;
  startsAfterFinish.delete(ctx.mouseState);
  return stray;
}

/**
 * Handle a Distance press (#8771). With nothing pending it sets the start; with
 * a start pending it is the second click, and the release finishes there.
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureDown(ctx: MouseHandlerContext, e: PointerEvent): boolean {
  const { canvas, mouseState } = ctx;

  mouseState.isDragging = true;
  canvas.style.cursor = 'crosshair';
  const afterFinish = finishingPresses.has(mouseState);
  startingPresses.delete(mouseState);
  forgetDistancePress(mouseState);
  if (ctx.activeMeasurementRef.current) return true;

  // Calculate canvas-relative coordinates
  const rect = canvas.getBoundingClientRect();
  const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const measurePoint = pickMeasurePoint(ctx, at.x, at.y);
  if (measurePoint) {
    beginDistance(ctx, measurePoint, at);
    startingPresses.add(mouseState);
    if (afterFinish) startsAfterFinish.add(mouseState);
  }

  return true;
}

/**
 * Handle the release of a Distance press with an active measurement.
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureUp(ctx: MouseHandlerContext, e: PointerEvent): boolean {
  const { canvas, renderer, camera, mouseState } = ctx;

  // Cancel any pending raycast to avoid stale updates
  cancelMeasureRaycast(ctx);

  // Do a final synchronous raycast at the mouseup position to ensure accurate end point
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const useOrthogonalConstraint = e.shiftKey && ctx.measurementConstraintEdgeRef.current;
  const currentLock = ctx.edgeLockStateRef.current;

  // Use simpler snap options in orthogonal mode (no magnetic locking needed)
  const finalLock = useOrthogonalConstraint
    ? { edge: null, meshExpressId: null, lockStrength: 0 }
    : currentLock;

  const result = renderer.raycastSceneMagnetic(mx, my, {
    edge: finalLock.edge,
    meshExpressId: finalLock.meshExpressId,
    lockStrength: finalLock.lockStrength,
  }, {
    hiddenIds: ctx.hiddenEntitiesRef.current,
    isolatedIds: ctx.isolatedEntitiesRef.current,
    snapOptions: measureSnapOptions(ctx, { axis: !!useOrthogonalConstraint }),
  });

  // The final position, snapped and (with Shift) on the axis
  let end: MeasurePoint | null = null;
  if (result.intersection || result.snapTarget) {
    const snapPoint = result.snapTarget || result.intersection;
    let pos = snapPoint ? ('position' in snapPoint ? snapPoint.position : snapPoint.point) : null;

    if (pos) {
      // Apply orthogonal constraint if shift is held
      if (useOrthogonalConstraint && ctx.activeMeasurementRef.current) {
        const constraint = ctx.measurementConstraintEdgeRef.current!;
        const start = ctx.activeMeasurementRef.current.start;
        const projected = projectOntoConstraintAxis(start, pos, constraint);
        pos = projected.projectedPos;
      }

      const screenPos = projectToCssScreen(camera, canvas, pos);
      end = {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        screenX: screenPos?.x ?? mx,
        screenY: screenPos?.y ?? my,
      };
    }
  }

  // The second click, or a press dragged past the click slop, finishes where it is released (#8771).
  // A release on background or back on the start keeps the start pending; a first click leaves it so.
  const finishing = !startingPresses.has(mouseState) || mouseState.didDrag;
  // On the Shift axis an end projected onto the start is the constrained answer, not a stray snap.
  const at = useOrthogonalConstraint ? undefined : { x: mx, y: my };
  if (finishing && end && finishDistance(ctx, end, at)) finishingPresses.add(mouseState);
  startingPresses.delete(mouseState);
  mouseState.isDragging = false;
  mouseState.didDrag = false;
  canvas.style.cursor = 'crosshair';
  return true;
}
