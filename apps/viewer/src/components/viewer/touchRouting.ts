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
 * through a per-canvas handler, the same way `markTouchSelection` hands off a
 * selection tap.
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { pickMeasurePoint } from './measurePick.js';
import { handleMeasureClickAt } from './selectionHandlers.js';

/** Wrap a pointer handler so touch-sourced pointer events never reach it. */
export function ignoreTouchPointers(handler: (e: PointerEvent) => unknown): (e: PointerEvent) => void {
  return (e) => {
    if (e.pointerType !== 'touch') void handler(e);
  };
}

const measureTapHandlers = new WeakMap<HTMLCanvasElement, (x: number, y: number) => void>();

/** Registered by the mouse controls, which own the measure context. */
export function setMeasureTapHandler(canvas: HTMLCanvasElement, handler: ((x: number, y: number) => void) | null): void {
  if (handler) measureTapHandlers.set(canvas, handler);
  else measureTapHandlers.delete(canvas);
}

/** Called by the touch controls on a tap in the Measure tool (canvas CSS px). */
export function routeMeasureTap(canvas: HTMLCanvasElement, x: number, y: number): boolean {
  const handler = measureTapHandlers.get(canvas);
  if (!handler) return false;
  handler(x, y);
  return true;
}

/**
 * A tap in the Measure tool. The click-driven modes place a point exactly as a
 * click does. Drag mode is press-drag-release with a mouse, but a finger drag
 * orbits, so on touch it takes two taps: the first sets the start, the second
 * completes the measurement.
 */
export function handleMeasureTap(ctx: MouseHandlerContext, x: number, y: number): void {
  const state = useViewerStore.getState();
  if (state.measureMode !== 'drag') {
    handleMeasureClickAt(ctx, x, y);
    return;
  }
  const point = pickMeasurePoint(ctx, x, y);
  if (!point) return;
  if (state.pendingMeasurePoint) state.completeMeasurement(point);
  else state.addMeasurePoint(point);
}
