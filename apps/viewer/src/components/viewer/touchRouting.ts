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
import type { MeasureInput } from '@/store/types';
import { pickMeasurePoint } from './measurePick.js';
import { beginDistance, finishDistance, pressOutlivedReset, resetMeasurePress } from './distanceClick.js';
import { handleMeasureClickAt } from './selectionHandlers.js';

/** The touch controls note each touch press so a tap can tell it outlived a Measure gesture reset (#8786). */
export { beginMeasurePress } from './distanceClick.js';

/**
 * Wrap a pointer handler so touch-sourced pointer events never reach it. This
 * is where mouse and touch part ways, so it also notes, in the Measure tool,
 * that the last input was a mouse (#8879); `handleMeasureTap` notes a tap.
 */
export function ignoreTouchPointers(handler: (e: PointerEvent) => unknown): (e: PointerEvent) => void {
  return (e) => {
    if (e.pointerType === 'touch') return;
    noteMeasureInput('mouse');
    void handler(e);
  };
}

/** The hint line words itself for the input the Measure gesture saw last (#8879). */
function noteMeasureInput(input: MeasureInput): void {
  const state = useViewerStore.getState();
  if (state.activeTool === 'measure') state.setMeasureInput(input);
}

const measureContexts = new WeakMap<HTMLCanvasElement, { ctx: MouseHandlerContext; stop: () => void }>();

/**
 * Registered by the mouse controls, which own the measure context; null on
 * unmount. While registered, every Measure gesture reset (the store's
 * `resetMeasureGesture` epoch: Esc, a mode or tool switch, a model
 * reposition) reaches the context's press state and queued frame (#8786).
 */
export function setMeasureContext(canvas: HTMLCanvasElement, ctx: MouseHandlerContext | null): void {
  measureContexts.get(canvas)?.stop();
  measureContexts.delete(canvas);
  if (!ctx) return;
  const stop = useViewerStore.subscribe((state, prev) => {
    if (state.measureGestureEpoch !== prev.measureGestureEpoch) resetMeasurePress(ctx);
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
  noteMeasureInput('touch');
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
