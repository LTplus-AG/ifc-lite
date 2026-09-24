/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way the viewer takes and drops pointer capture (#5403).
 *
 * Capture is an enhancement to a drag, never a precondition: it only keeps
 * move/up events arriving while the pointer is outside the element. But
 * `Element.setPointerCapture` THROWS in states a drag handler cannot rule out
 * (Pointer Events 3, "setPointerCapture"):
 *
 *  - `InvalidStateError` when the element is no longer connected, or when
 *    pointer lock is active on its document — e.g. the viewport's right-button
 *    fly mode holds pointer lock, and a further pointerdown on the canvas then
 *    tried to capture;
 *  - `NotFoundError` when the id names no active pointer — the pointer was
 *    released or cancelled before the handler ran, or the event is synthetic.
 *
 * Called raw at the top of a pointerdown handler, that throw aborted the
 * handler before it recorded its drag state, so the gesture silently died and
 * the error surfaced in PostHog. These helpers treat exactly those two refusals
 * as "no capture this time" (logged at debug, so a real capture bug stays
 * visible) and rethrow anything else. The raw DOM methods are banned outside
 * this file by `no-restricted-properties` in `.oxlintrc.json`.
 */

/** The slice of `Element` capture needs; lets a test pass a fake without a cast. */
export type PointerCaptureTarget = Pick<
  Element,
  'isConnected' | 'setPointerCapture' | 'releasePointerCapture' | 'hasPointerCapture'
>;

/** DOM exception names the capture methods use to refuse a benign state; anything else is a bug. */
const REFUSALS = new Set(['InvalidStateError', 'NotFoundError']);

/**
 * Matched by `name`, not `instanceof`: a panel detached into its own window
 * (`services/panel-windows.ts`) raises the DOMException from THAT window's
 * realm, which is not an instance of this realm's `Error` or `DOMException`.
 */
function isRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return typeof error.name === 'string' && REFUSALS.has(error.name);
}

/**
 * Capture `pointerId` on `el` so move/up keep arriving when the pointer leaves
 * it. Returns whether capture was taken; callers must carry on with the drag
 * either way. A missing or disconnected element is skipped without calling the
 * DOM at all.
 */
export function capturePointer(el: PointerCaptureTarget | null | undefined, pointerId: number): boolean {
  if (!el?.isConnected) return false;
  try {
    // The one sanctioned call site of the raw DOM method (see the file header).
    // eslint-disable-next-line no-restricted-properties
    el.setPointerCapture(pointerId);
    return true;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    console.debug('[pointer-capture] setPointerCapture refused; continuing the drag without capture', error);
    return false;
  }
}

/**
 * Release `pointerId` from `el` if, and only if, `el` still holds it. Safe on
 * pointerup, pointercancel, and after the browser has already dropped capture
 * implicitly, which are the cases the old ad-hoc `try {} catch {}` guards covered.
 */
export function releasePointer(el: PointerCaptureTarget | null | undefined, pointerId: number): void {
  if (!el?.hasPointerCapture(pointerId)) return;
  try {
    // The one sanctioned call site of the raw DOM method (see the file header).
    // eslint-disable-next-line no-restricted-properties
    el.releasePointerCapture(pointerId);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    console.debug('[pointer-capture] releasePointerCapture refused; capture was already gone', error);
  }
}
