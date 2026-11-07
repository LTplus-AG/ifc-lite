/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Single-finger long press without an orbit, tap, or duplicate native menu (#5859). */
import { TAP_SLOP_PX } from './tapSlop.js';

const HOLD_MS = 500;
/** How long after a long press fires, and how near its point (CSS px), the touch's own native menu may still come. */
const MENU_MS = 1_000, MENU_RADIUS_PX = 24;

/** A point whose native menu is the touch's; `mouse` once a mouse or trackpad press near it was seen (#9087). */
interface MenuPoint { x: number; y: number; mouse: boolean }

const longPresses = new WeakMap<HTMLCanvasElement, { forget: (clientX: number, clientY: number) => void }>();

/**
 * A mouse or trackpad press near a held or just-fired long press, as the
 * mouse controls see it (the same press that closes a Pencil lift's click
 * window, #9043): the context menu after it is that press's own, so the long
 * press no longer swallows it (#9087). Its own menu, typed `touch` or `pen`,
 * stays suppressed.
 */
export function forgetTouchLongPress(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  longPresses.get(canvas)?.forget(clientX, clientY);
}

export function createTouchLongPress(canvas: HTMLCanvasElement, onHold: (x: number, y: number) => void): {
  begin: (touch: Touch) => void;
  move: (touch: Touch) => boolean;
  end: () => boolean;
  cancel: () => void;
  suppressNativeMenu: (event: MouseEvent) => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: (MenuPoint & { id: number }) | null = null;
  let fired = false;
  let menuWindow: (MenuPoint & { until: number }) | null = null;

  const near = (point: MenuPoint, x: number, y: number) => Math.hypot(x - point.x, y - point.y) <= MENU_RADIUS_PX;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const cancel = () => {
    clearTimer();
    start = null;
    fired = false;
  };
  const registration = {
    forget(x: number, y: number) {
      for (const point of [start, menuWindow]) if (point && near(point, x, y)) point.mouse = true;
    },
  };
  longPresses.set(canvas, registration);

  return {
    begin(touch) {
      cancel();
      fired = false;
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, mouse: false };
      timer = setTimeout(() => {
        timer = null;
        if (!start) return;
        fired = true;
        menuWindow = { ...start, until: Date.now() + MENU_MS };
        onHold(start.x, start.y);
      }, HOLD_MS);
    },
    move(touch) {
      if (!start || touch.identifier !== start.id || fired) return fired;
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP_PX) {
        cancel();
        return false;
      }
      // Keep the camera fixed while the finger stays within tap slop.
      return true;
    },
    end() {
      const held = fired;
      cancel();
      return held;
    },
    cancel,
    suppressNativeMenu(event) {
      const point = start ?? (menuWindow && Date.now() < menuWindow.until ? menuWindow : null);
      if (!point || !near(point, event.clientX, event.clientY)) return;
      const pointerType = (event as MouseEvent & { pointerType?: string }).pointerType;
      if (point.mouse && pointerType !== 'touch' && pointerType !== 'pen') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    dispose() {
      cancel();
      if (longPresses.get(canvas) === registration) longPresses.delete(canvas);
    },
  };
}
