/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure viewport rules for the Space Sketch canvas: where a pointer event lands
 * and how far the wheel may zoom.
 *
 * Both exist because of a specific failure, and both were previously inline in
 * the overlay where nothing could pin them.
 */

import { zoomFit, type Fit } from '@/lib/space-sketch-geometry';

/** Wheel-zoom range. Outside it the gesture is refused, not clamped. */
export const MIN_ZOOM_SCALE = 0.5;
export const MAX_ZOOM_SCALE = 5000;
/** Wheel sensitivity: scroll up (negative deltaY) zooms in. */
const ZOOM_PER_WHEEL_UNIT = 0.0015;

/**
 * Clamp a canvas-relative pointer position into the `w`×`h` canvas.
 *
 * During a drag the pointer is captured, so moving it past the panel (e.g.
 * dragging a vertex down off the bottom) reports coordinates far outside the
 * SVG → a huge off-screen world position. That pushed the room off-canvas
 * ("disappears") and made the SVG rasterise a polygon spanning to extreme
 * coordinates, freezing the browser.
 */
export function clampToCanvas(x: number, y: number, w: number, h: number): [number, number] {
  return [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))];
}

/**
 * The fit after a wheel notch of `deltaY` about canvas point `(ax, ay)`, or
 * `null` when the result would leave the usable zoom range.
 *
 * Returning null rather than a clamped fit is deliberate: clamping the *scale*
 * while still applying the offset shift would drift the plan sideways under a
 * wheel that no longer zooms, so a refused gesture must move nothing at all.
 */
export function zoomStep(f: Fit, deltaY: number, ax: number, ay: number): Fit | null {
  const next = zoomFit(f, Math.exp(-deltaY * ZOOM_PER_WHEEL_UNIT), ax, ay);
  return next.scale >= MIN_ZOOM_SCALE && next.scale <= MAX_ZOOM_SCALE ? next : null;
}
