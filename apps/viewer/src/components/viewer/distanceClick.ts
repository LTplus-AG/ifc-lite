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
import { pickMeasurePoint, pickSurfacePoint } from './measurePick.js';
import { cancelTrailingHover } from './measurePointMode.js';
import { isDuplicateClickPoint, projectOntoConstraintAxis } from './measureHandlers.js';

/** Presses that set a distance start, so their release can tell a first click from a second (#8771). */
const startingPresses = new WeakSet<MouseState>();
/** The last press finished a distance; a start right after it may be a double-click's second press. */
const finishingPresses = new WeakSet<MouseState>();
/** The last press set a start right after a finish: a dblclick on it drops that start. */
const startsAfterFinish = new WeakSet<MouseState>();
/**
 * Where the pending start was pressed, before snapping, and where it showed then (#8788).
 * Matched to the start by world position: a camera move rebuilds the start object.
 */
const startPresses = new WeakMap<MouseState, { world: { x: number; y: number; z: number }; press: { x: number; y: number }; shown: { x: number; y: number } }>();
/** A second press within this far (CSS px) of the start's own press is that press repeated (#8788). */
const REPRESS_SLOP_PX = 8;
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

/** Drop a queued rubber-band or hover raycast, so it cannot land after the press or gesture it served. */
function cancelMeasureRaycast(ctx: MouseHandlerContext): void {
  if (ctx.measureRaycastFrameRef.current !== null) cancelAnimationFrame(ctx.measureRaycastFrameRef.current);
  ctx.measureRaycastFrameRef.current = null;
  ctx.measureRaycastPendingRef.current = false;
}

/**
 * The pointer side of a Measure gesture reset (#8786), run whenever the store's
 * `resetMeasureGesture` bumps the epoch: the queued raycast frame would set the
 * snap target, edge lock and glyph the reset just cleared, and this press
 * state's records belong to the gesture that is gone. The frame ref is shared
 * with the command tool's preview, so only a Measure frame is dropped.
 */
export function resetMeasurePress(ctx: MouseHandlerContext): void {
  if (ctx.activeToolRef.current === 'measure') { cancelMeasureRaycast(ctx); cancelTrailingHover(ctx); }
  startingPresses.delete(ctx.mouseState);
  startPresses.delete(ctx.mouseState);
  forgetDistancePress(ctx.mouseState);
}

/** Set a distance start and its Shift axis triad. Shared by the first click and the first tap (#8771). */
export function beginDistance(ctx: MouseHandlerContext, measurePoint: MeasurePoint, at?: { x: number; y: number }): void {
  ctx.startMeasurement(measurePoint);
  if (at) {
    const { x, y, z, screenX, screenY } = measurePoint;
    startPresses.set(ctx.mouseState, { world: { x, y, z }, press: at, shown: { x: screenX, y: screenY } });
  } else {
    startPresses.delete(ctx.mouseState);
  }

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
  if (at && isDuplicateClickPoint(active.start, end) && pressedAwayFromStart(ctx, active.start, at)) {
    end = pickSurfacePoint(ctx, at.x, at.y) ?? end;
  }
  if (isDuplicateClickPoint(active.start, end)) return false;
  ctx.updateMeasurement(end);
  ctx.finalizeMeasurement();
  return true;
}

/**
 * Whether a press at `at` is clearly a new point: away from where the start was
 * pressed (so not a double-click or double-tap snapping to the same target) and
 * not on the start as it now shows (so not a retap on it after the camera moved).
 */
function pressedAwayFromStart(ctx: MouseHandlerContext, start: MeasurePoint, at: { x: number; y: number }): boolean {
  const record = startPresses.get(ctx.mouseState);
  if (!record || record.world.x !== start.x || record.world.y !== start.y || record.world.z !== start.z) return false;
  const shown = projectToCssScreen(ctx.camera, ctx.canvas, start) ?? { x: start.screenX, y: start.screenY };
  // The press moves on screen with the start when the camera does, so a repeated press still
  // counts after a small drift (inertia, a reprojection) as well as after none.
  const press = { x: record.press.x + shown.x - record.shown.x, y: record.press.y + shown.y - record.shown.y };
  const nearPress = Math.hypot(at.x - press.x, at.y - press.y) <= REPRESS_SLOP_PX;
  // A press on the shown start itself stays a retap, as finishDistance's duplicate guard has it.
  return !nearPress && !isDuplicateClickPoint({ screenX: shown.x, screenY: shown.y }, { screenX: at.x, screenY: at.y });
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
    snapOptions: ctx.snapEnabledRef.current && !useOrthogonalConstraint ? {
      snapToVertices: true,
      snapToEdges: true,
      snapToFaces: true,
      screenSnapRadius: 60,
    } : useOrthogonalConstraint ? {
      // In orthogonal mode, snap to edges and vertices only (no faces)
      snapToVertices: true,
      snapToEdges: true,
      snapToFaces: false,
      screenSnapRadius: 40,
    } : {
      snapToVertices: false,
      snapToEdges: false,
      snapToFaces: false,
      screenSnapRadius: 0,
    },
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
