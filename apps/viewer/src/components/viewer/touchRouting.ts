/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One owner per touch (#5856).
 *
 * A finger fires pointer events as well as touch events. The mouse controls
 * handled both, so one drag was orbited by `useMouseControls` AND
 * `useTouchControls`, and in Measure the mouse path started a drag
 * measurement while the touch path orbited underneath it. Touch now belongs
 * to `useTouchControls` alone: the mouse controls ignore touch-sourced pointer
 * events, and a Measure tap is handed to the mouse side's measure logic
 * through a per-canvas measure context, the same way `markTouchSelection`
 * hands off a selection tap.
 *
 * A pen press has one owner too (#9000). iOS Safari sends an Apple Pencil
 * press as pointer events (`pointerType: 'pen'`) and as touch events
 * (`Touch.touchType: 'stylus'`), the pointerdown first and the touchstart right
 * after it, in the same task. A desktop pen (Wacom, Surface) sends pointer
 * events only. So the mouse controls hold a pen pointerdown for one task: a
 * touchstart in that time, from a stylus or at the pen's point, hands the
 * whole press to the touch controls and the mouse side ignores that pointer
 * until it lifts. Without one, the held pointerdown runs as before, and any
 * later mouse-side event runs it first so the order is kept.
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { pickMeasurePoint } from './measurePick.js';
import { beginDistance, finishDistance, pressOutlivedReset, resetMeasurePress } from './distanceClick.js';
import { measureSnapOff } from './measureSnapOff.js';
import { noteMeasureCursor } from './measureCursor.js';
import { handleMeasureClickAt } from './selectionHandlers.js';
import { forgetTouchSelection } from './referenceSelection.js';

/** The touch controls note each touch press so a tap can tell it outlived a Measure gesture reset (#8786). */
export { beginMeasurePress } from './distanceClick.js';

type PointerHandler = (e: PointerEvent) => unknown;

interface PenGate {
  /** A pen pointerdown waiting one task for a touchstart that would claim it. */
  held: { e: PointerEvent; timer: ReturnType<typeof setTimeout> } | null;
  /** Pen pointers whose press the touch controls own, until they lift. */
  owned: Set<number>;
  /** The touches down, as of their touchstart: a pen pointerdown after one of them is the touch side's. */
  touches: Touch[];
  /**
   * Where and when the last touch-owned pen press lifted, to drop its
   * compatibility click, dblclick or contextmenu. A mouse or trackpad
   * pointerdown at the lift point clears it (#9043): a genuine click starts with one, a Pencil's
   * compatibility events never do, and a dblclick has no pointerType to tell.
   * A pen pointerdown does not: the earlier tap's click may still be on its way.
   */
  lift: { time: number; x: number; y: number } | null;
}

const penGates = new WeakMap<HTMLCanvasElement, PenGate>();
/** A touch this close (CSS px) to a held pen pointerdown is the same press. */
const PEN_TOUCH_SLOP = 8;
/** The same window and slop `isTouchSelectionClick` uses for a tap's compatibility click. */
const PEN_CLICK_MS = 700, PEN_CLICK_SLOP = 5;
const atLift = (e: MouseEvent, lift: { x: number; y: number }) =>
  Math.abs(e.clientX - lift.x) <= PEN_CLICK_SLOP && Math.abs(e.clientY - lift.y) <= PEN_CLICK_SLOP;

export interface MousePointerRoute {
  down: (e: PointerEvent) => void;
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  cancel: (e: PointerEvent) => void;
  /** Wrap another mouse-side handler (context menu, click): a held pen press runs first, a touch-owned pen's compatibility click is dropped. */
  after: <E extends MouseEvent>(handler: (e: E) => unknown) => (e: E) => void;
  dispose: () => void;
}

/**
 * The mouse controls' pointer handlers, with touch-sourced pointer events
 * dropped (#5856) and pen presses routed to one pipeline (#9000). This is where
 * the mouse controls part from touch, so it also notes the input the viewport
 * saw last through `noteMouseSideInput` (#8879): a pen words the hints as touch does, since a stylus taps
 * and often has no keyboard. The touch controls note a finger.
 */
export function routeMousePointers(
  canvas: HTMLCanvasElement,
  handlers: { down: PointerHandler; move: PointerHandler; up: PointerHandler; cancel: PointerHandler },
): MousePointerRoute {
  const gate: PenGate = { held: null, owned: new Set(), touches: [], lift: null };
  penGates.set(canvas, gate);
  const runHeld = () => {
    const held = gate.held;
    if (!held) return;
    gate.held = null;
    clearTimeout(held.timer);
    void handlers.down(held.e);
  };
  const touchOwned = (e: PointerEvent) => e.pointerType === 'touch' || (e.pointerType === 'pen' && gate.owned.has(e.pointerId));
  const pass = (handler: PointerHandler) => (e: PointerEvent) => {
    if (touchOwned(e)) return;
    runHeld();
    void handler(e);
  };
  return {
    down: (e) => {
      if (e.pointerType === 'touch') return;
      noteMouseSideInput(e.pointerType);
      runHeld();
      if (e.pointerType !== 'pen') {
        // a mouse or trackpad press at the lift point: the click there is its own, not a lifted Pencil's (#9043)
        if (gate.lift && atLift(e, gate.lift)) gate.lift = null;
        const rect = canvas.getBoundingClientRect();
        forgetTouchSelection(canvas, e.clientX - rect.left, e.clientY - rect.top); // nor a tap's, in Select
        void handlers.down(e);
        return;
      }
      e.preventDefault(); // handleMouseDown's own call would come too late to stop compatibility mouse events
      gate.owned.delete(e.pointerId); // a new press: an earlier one's pointerup may have been stopped before reaching us
      if (gate.touches.some((t) => samePress(t, e))) gate.owned.add(e.pointerId);
      else gate.held = { e, timer: setTimeout(runHeld, 0) };
    },
    move: (e) => {
      // A Measure preview follows only the moves its own handlers note again (#8992)
      const measure = measureContexts.get(canvas)?.ctx;
      if (measure) noteMeasureCursor(measure, null);
      // A Pencil hovering with nothing down, after a press whose pointerup never reached us
      if (e.pointerType === 'pen' && e.buttons === 0 && gate.touches.length === 0) gate.owned.delete(e.pointerId);
      if (e.pointerType !== 'touch') noteMouseSideInput(e.pointerType);
      pass(handlers.move)(e);
    },
    up: (e) => {
      if (e.pointerType !== 'touch') noteMouseSideInput(e.pointerType);
      if (e.pointerType === 'pen' && gate.owned.delete(e.pointerId)) {
        gate.lift = { time: Date.now(), x: e.clientX, y: e.clientY };
        return;
      }
      pass(handlers.up)(e);
    },
    cancel: (e) => {
      if (e.pointerType === 'pen' && gate.owned.delete(e.pointerId)) return;
      if (gate.held?.e.pointerId === e.pointerId && e.pointerType === 'pen') {
        clearTimeout(gate.held.timer);
        gate.held = null; // the press never reached the mouse side
        return;
      }
      pass(handlers.cancel)(e);
    },
    after: (handler) => (e) => {
      const pointerType = (e as MouseEvent & { pointerType?: string }).pointerType;
      const lift = gate.lift;
      if (lift && (pointerType === 'pen' || !pointerType) && Date.now() - lift.time <= PEN_CLICK_MS && atLift(e, lift)) {
        if (e.type === 'contextmenu') e.preventDefault(); // as handleContextMenu would have
        return;
      }
      runHeld();
      void handler(e);
    },
    dispose: () => {
      if (gate.held) clearTimeout(gate.held.timer);
      if (penGates.get(canvas) === gate) penGates.delete(canvas);
    },
  };
}

/**
 * A touch from a stylus (`Touch.touchType`, WebKit) is the same press as the pen
 * pointer; so is one at the pen's point from a browser that has no `touchType`.
 */
function samePress(t: Touch, pen: PointerEvent): boolean {
  const touchType = (t as Touch & { touchType?: string }).touchType;
  return touchType === 'stylus' || (touchType === undefined
    && Math.abs(t.clientX - pen.clientX) <= PEN_TOUCH_SLOP && Math.abs(t.clientY - pen.clientY) <= PEN_TOUCH_SLOP);
}

/**
 * Called by the touch controls on touchstart, touchend and touchcancel (#9000):
 * a touchstart from a stylus, or at the point of a held pen pointerdown, takes
 * that pen press from the mouse controls; so does a pen pointerdown that
 * comes after such a touchstart.
 */
export function notePenTouches(canvas: HTMLCanvasElement, e: TouchEvent): void {
  const gate = penGates.get(canvas);
  if (!gate) return;
  // Kept as of each touch's touchstart: an earlier touch keeps its entry, a new one is added
  const down = Array.from(e.touches ?? []);
  gate.touches = down.map((t) => gate.touches.find((k) => k.identifier === t.identifier) ?? t);
  const held = gate.held;
  if (e.type !== 'touchstart' || !held) return;
  if (!Array.from(e.changedTouches ?? []).some((t) => samePress(t, held.e))) return;
  clearTimeout(held.timer);
  gate.held = null;
  gate.owned.add(held.e.pointerId);
}

/**
 * Notes a mouse-side input as the one the viewport saw last (#8879). The wheel
 * passes `'mouse'`: a wheel or trackpad scroll, and a trackpad pinch (a
 * ctrl+wheel), is mouse-class input (#8999).
 */
export function noteMouseSideInput(pointerType: string): void {
  useViewerStore.getState().setPointerInput(pointerType === 'pen' ? 'touch' : 'mouse');
}

const measureContexts = new WeakMap<HTMLCanvasElement, { ctx: MouseHandlerContext; stop: () => void }>();

/**
 * Registered by the mouse controls, which own the measure context; null on
 * unmount. While registered, every Measure gesture reset (the store's
 * `resetMeasureGesture` epoch: Esc, a mode or tool switch, a model
 * reposition) reaches the context's press state and queued frame (#8786),
 * and turning Snap off drops the queued frame and re-picks the live preview
 * unsnapped (#8881, #8992).
 */
export function setMeasureContext(canvas: HTMLCanvasElement, ctx: MouseHandlerContext | null): void {
  measureContexts.get(canvas)?.stop();
  measureContexts.delete(canvas);
  if (!ctx) return;
  const stop = useViewerStore.subscribe((state, prev) => {
    if (state.measureGestureEpoch !== prev.measureGestureEpoch) resetMeasurePress(ctx);
    // A command's preview frame is its own
    else if (prev.snapEnabled && !state.snapEnabled && ctx.activeToolRef.current === 'measure') measureSnapOff(ctx);
  });
  measureContexts.set(canvas, { ctx, stop });
}

/**
 * Called by the touch controls on a tap in the Measure tool (canvas CSS px).
 * `press` is the touch the tap ends: one begun before a Measure gesture reset
 * (Esc, a mode or tool switch) places nothing (#8786).
 */
export function routeMeasureTap(canvas: HTMLCanvasElement, x: number, y: number, press?: object): boolean {
  const registered = measureContexts.get(canvas);
  if (!registered) return false;
  if (!press || !pressOutlivedReset(press)) handleMeasureTap(registered.ctx, x, y);
  return true;
}

/**
 * A tap in the Measure tool places a point exactly as a click does. Distance
 * is two clicks or two taps on one path (#8771): the first sets the start, the
 * second completes the measurement.
 */
export function handleMeasureTap(ctx: MouseHandlerContext, x: number, y: number): void {
  noteMeasureCursor(ctx, null); // a mouse resting elsewhere does not drive a touch gesture's preview (#8992)
  const state = useViewerStore.getState();
  if (state.measureMode !== 'drag') {
    handleMeasureClickAt(ctx, x, y);
    return;
  }
  const point = pickMeasurePoint(ctx, x, y);
  if (!point) return;
  if (ctx.activeMeasurementRef.current) finishDistance(ctx, point, { x, y });
  else beginDistance(ctx, point, { x, y });
}

/** The mouse controls' handler context, while registered: a touch tap in Section or the command tool runs through it (#9042). */
export function viewportHandlerContext(canvas: HTMLCanvasElement): MouseHandlerContext | null {
  return measureContexts.get(canvas)?.ctx ?? null;
}
