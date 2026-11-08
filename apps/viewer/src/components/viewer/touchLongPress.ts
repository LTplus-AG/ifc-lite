/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Single-finger long press without an orbit, tap, or duplicate native menu (#5859). */
import { TAP_SLOP_PX } from './tapSlop.js';

export const HOLD_MS = 500;
/** How long after a long press fires or lifts, and how near its point (CSS px), the touch's own native menu may still come. */
const MENU_MS = 1_000, MENU_RADIUS_PX = 24;

/** A point whose native menu is the touch's; `mouse` once a mouse or trackpad menu press near it was seen (#9087). */
interface MenuPoint { x: number; y: number; mouse: boolean }

const longPresses = new WeakMap<HTMLCanvasElement, { forget: (clientX: number, clientY: number) => void }>();

/**
 * A mouse or trackpad press near a held or just-fired long press, as the
 * mouse controls see it (the same press that closes a Pencil lift's click
 * window, #9043). A right press, or a ctrl+click, opens a menu: the next
 * untyped context menu near it is that press's own, so the long press lets it
 * through once (#9087), and a hold still pending opens no menu of its own
 * (#9223). A press with no long press near it yet is kept for a finger that
 * lands near it within `MENU_MS`: on Windows its menu comes at the release,
 * untyped in an engine whose contextmenu is no PointerEvent (#9223). The
 * touch's own menu, typed `touch` or `pen`, stays suppressed; one typed
 * `mouse` is never the touch's.
 */
export function forgetTouchLongPress(canvas: HTMLCanvasElement, e: MouseEvent): void {
  if (e.button === 2 || e.ctrlKey) longPresses.get(canvas)?.forget(e.clientX, e.clientY);
}

export function createTouchLongPress(canvas: HTMLCanvasElement, onHold: (x: number, y: number) => void): {
  /**
   * A finger landed. `hold: false` for a press whose rest is no long press (a
   * command's grab, #9228): `onHold` never fires, yet the touch's own native
   * menu is still suppressed, so it opens no viewer menu under the drag.
   */
  begin: (touch: Touch, options?: { hold?: boolean }) => void;
  move: (touch: Touch) => boolean;
  end: () => boolean;
  cancel: () => void;
  suppressNativeMenu: (event: MouseEvent) => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: (MenuPoint & { id: number }) | null = null;
  let fired = false;
  /** The press may fire `onHold` (`begin`'s `hold`). */
  let holds = true;
  /** A mouse or trackpad menu press near the finger stopped its hold: the menu is the press's (#9223). */
  let muted = false;
  let startedAt = 0;
  let menuWindow: (MenuPoint & { until: number }) | null = null;
  /** A menu press that came before any long press near it, waiting for its menu or a finger. */
  let pressBefore: { x: number; y: number; time: number } | null = null;

  const near = (point: { x: number; y: number }, x: number, y: number) => Math.hypot(x - point.x, y - point.y) <= MENU_RADIUS_PX;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const cancel = () => {
    clearTimer();
    start = null;
    fired = false;
    muted = false;
  };
  const registration = {
    forget(x: number, y: number) {
      for (const point of [start, menuWindow]) if (point && near(point, x, y)) point.mouse = true;
      // The press's menu is the one asked for: a hold still pending must not replace it (#9223).
      if (start && !fired && near(start, x, y)) { clearTimer(); muted = true; }
      // With no finger down next to it, a finger may still land before its menu comes (Windows, #9223)
      pressBefore = start && near(start, x, y) ? null : { x, y, time: Date.now() };
    },
  };
  longPresses.set(canvas, registration);

  return {
    begin(touch, { hold = true } = {}) {
      cancel();
      fired = false;
      holds = hold;
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, mouse: false };
      startedAt = Date.now();
      // A finger landing next to a menu press whose menu has not come yet: that menu is the press's (#9223).
      if (pressBefore && Date.now() - pressBefore.time <= MENU_MS && near(start, pressBefore.x, pressBefore.y)) {
        pressBefore = null;
        start.mouse = muted = true;
        return;
      }
      if (!hold) return;
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
      // A muted finger held past the long-press threshold is still a hold: no tool places on its lift (#9223).
      // A press with no hold (a grab) stays the command's press and release, muted or not (#9228).
      const held = fired || (holds && muted && start !== null && Date.now() - startedAt >= HOLD_MS);
      // Windows sends a held touch's own menu at the lift, however long the hold, and whether or
      // not a mouse press muted it (#9223): its window runs from the lift.
      if (fired && menuWindow) menuWindow.until = Date.now() + MENU_MS;
      else if (start && (muted || (!holds && Date.now() - startedAt >= HOLD_MS))) menuWindow = { ...start, until: Date.now() + MENU_MS };
      cancel();
      return held;
    },
    cancel,
    suppressNativeMenu(event) {
      if (pressBefore && near(pressBefore, event.clientX, event.clientY)) pressBefore = null; // its menu came
      const point = start ?? (menuWindow && Date.now() < menuWindow.until ? menuWindow : null);
      if (!point || !near(point, event.clientX, event.clientY)) return;
      const source = event as MouseEvent & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } };
      const touchTyped = source.pointerType === 'touch' || source.pointerType === 'pen' || source.sourceCapabilities?.firesTouchEvents;
      // Marked as from touch first, as `isTouchSelectionClick` reads it: never the mouse's
      if (!touchTyped && (source.pointerType === 'mouse' || point.mouse)) {
        for (const p of [start, menuWindow]) if (p) p.mouse = false; // the press's one menu
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    dispose() {
      cancel();
      if (longPresses.get(canvas) === registration) longPresses.delete(canvas);
    },
  };
}
