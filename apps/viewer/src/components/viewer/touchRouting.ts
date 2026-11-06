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
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { pickMeasurePoint } from './measurePick.js';
import { beginDistance, finishDistance, pressOutlivedReset, resetMeasurePress } from './distanceClick.js';
import { measureSnapOff } from './measureSnapOff.js';
import { noteMeasureCursor } from './measureCursor.js';
import { handleMeasureClickAt } from './selectionHandlers.js';

/** The touch controls note each touch press so a tap can tell it outlived a Measure gesture reset (#8786). */
export { beginMeasurePress } from './distanceClick.js';

/**
 * Wrap a pointer handler so touch-sourced pointer events never reach it. This
 * is where the mouse controls part from touch, so it also notes the input the
 * viewport saw last (#8879): a pen words the hints as touch does, since a
 * stylus taps and often has no keyboard. The touch controls note a finger.
 */
export function ignoreTouchPointers(handler: (e: PointerEvent) => unknown): (e: PointerEvent) => void {
  return (e) => {
    if (e.pointerType === 'touch') return;
    noteMouseSideInput(e.pointerType);
    void handler(e);
  };
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
