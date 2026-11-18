/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure screen-space helpers for measure clicks (moved out of measureHandlers.ts; this module must not import the store). */

/** Screen-space distance (CSS px) between two points. Used by both the
 *  close-loop check and the double-click duplicate-point check below —
 *  screen space, not world space, so either tolerance feels the same at any
 *  zoom level, the same reasoning `screenSnapRadius` uses for vertex
 *  snapping above. */
function screenDistance(
  a: { screenX: number; screenY: number },
  b: { screenX: number; screenY: number },
): number {
  return Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY);
}

/** Screen-space radius (CSS px) within which a click on the polyline's first
 *  point closes the loop instead of appending a new (near-duplicate) point. */
export const CLOSE_LOOP_SCREEN_RADIUS_PX = 14;

/**
 * Whether `candidate` landed close enough to `first` (in screen space) that
 * the click should close the polyline loop rather than add a new point.
 */
export function isNearPolylineStart(
  candidate: { screenX: number; screenY: number },
  first: { screenX: number; screenY: number },
  radiusPx: number = CLOSE_LOOP_SCREEN_RADIUS_PX,
): boolean {
  return screenDistance(candidate, first) <= radiusPx;
}

/**
 * Screen-space radius (CSS px) below which two consecutive polyline points
 * are treated as the same physical click, not two deliberate placements.
 *
 * Browsers dispatch `click`, `click`, `dblclick` for one physical
 * double-click gesture — never just `dblclick` (MDN). `handlePolylineClick`
 * runs on both leading `click`s, so a double-click meant to "place the last
 * point and finish" appends it twice, a couple px apart (often the exact
 * same reported coordinate), before the `dblclick` handler's
 * `finishPolyline` call ever runs.
 *
 * Deliberately much smaller than {@link CLOSE_LOOP_SCREEN_RADIUS_PX}: that
 * radius means "click intentionally near the loop's start", this one means
 * "these two clicks were actually one gesture" — conflating them would make
 * a legitimate short segment swallow a real vertex (a 3-4-5 triangle's
 * shortest edges are 3px/4px in `selectionHandlers.polyline.test.ts`'s
 * screen-equals-world fixture, so this must stay well under that).
 */
export const DUPLICATE_POINT_SCREEN_RADIUS_PX = 2;

/**
 * Whether `a` and `b` are close enough (screen space) to be the two leading
 * `click` events of one physical double-click, per
 * {@link DUPLICATE_POINT_SCREEN_RADIUS_PX}.
 *
 * Only meaningful on the double-click finish path. Placed points are
 * reprojected on every camera move (`updateMeasurementScreenCoords`), so two
 * genuinely distinct vertices can satisfy this after an orbit — see
 * `finishPolyline`'s `fromDoubleClick` option in measurementSlice.ts.
 */
export function isDuplicateClickPoint(
  a: { screenX: number; screenY: number },
  b: { screenX: number; screenY: number },
): boolean {
  return screenDistance(a, b) <= DUPLICATE_POINT_SCREEN_RADIUS_PX;
}
