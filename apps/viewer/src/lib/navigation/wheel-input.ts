/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One reading of a wheel event for every viewer view (#9507): the 3D
 * viewport, the 2D drawing, the plan canvas, fly speed and the appearance
 * preview.
 *
 * `deltaMode` decides the unit of `deltaY`. Chromium and Safari report
 * pixels; Firefox can report lines (a notch is 3) and some devices report
 * pages. Read raw, a line-mode notch zooms about thirty times less than a
 * pixel-mode one. Every library we compared converts it (three.js, MapLibre,
 * Cesium, Leaflet, Babylon, model-viewer), and the views here used to carry
 * three different conversions, or none.
 */

/** CSS px per line: a three-line notch equals the 100 px notch Chromium reports. */
const WHEEL_LINE_PX = 100 / 3;
/** CSS px per page when the caller has no page height of its own. */
export const WHEEL_PAGE_PX = 800;
/**
 * One event at least this large, in CSS px, is a discrete wheel notch. A
 * trackpad or a smooth-scrolling wheel streams smaller deltas, many per frame.
 */
export const WHEEL_NOTCH_MIN_PX = 40;

/** `delta` in CSS px. Non-finite input reads as no movement. */
export function wheelDeltaPx(delta: number, deltaMode: number, pagePx: number = WHEEL_PAGE_PX): number {
  if (!Number.isFinite(delta)) return 0;
  const px = deltaMode === 1 ? delta * WHEEL_LINE_PX : deltaMode === 2 ? delta * pagePx : delta;
  return Number.isFinite(px) ? px : 0;
}

/** The user's wheel-zoom speed, saved per browser (Settings → Display → Navigation). */
export type WheelZoomSensitivity = 'slow' | 'normal' | 'fast';

export const WHEEL_ZOOM_SENSITIVITIES: readonly WheelZoomSensitivity[] = ['slow', 'normal', 'fast'];

/** Each level halves or doubles the step, so a notch is about 5 %, 10 % or 20 %. */
const SENSITIVITY_FACTOR: Record<WheelZoomSensitivity, number> = { slow: 0.5, normal: 1, fast: 2 };

export function wheelZoomSensitivityFactor(sensitivity: WheelZoomSensitivity): number {
  return SENSITIVITY_FACTOR[sensitivity];
}

/** A persisted choice is untrusted browser data. Unknown values use `normal`. */
export function parseWheelZoomSensitivity(value: string | null): WheelZoomSensitivity {
  return WHEEL_ZOOM_SENSITIVITIES.find((s) => s === value) ?? 'normal';
}

/** Natural-log zoom per wheel px in the 2D views: a 100 px notch zooms 10 %. */
const ZOOM_LOG_PER_PX = Math.log(1.1) / 100;

/**
 * The 2D views' zoom for `px` of wheel travel, as a scale multiplier: above 1
 * zooms in (scroll up, negative `px`). Exponential, so the eased slices of a
 * notch compound to exactly the notch (#9507). The smoother bounds the travel
 * per step and per gesture; the fine step and the sensitivity are already in
 * `px`.
 */
export function wheelZoomScale(px: number): number {
  const scale = Math.exp(-px * ZOOM_LOG_PER_PX);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
