/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finiteness predicates shared by every camera sub-system.
 *
 * They live in one module rather than next to their first caller because the
 * same three mistakes keep being made independently in `camera.ts`,
 * `camera-controls.ts`, `camera-animation.ts` and `camera-projection.ts`:
 *
 *  - **A magnitude comparison is not a finiteness check.** Every comparison
 *    involving NaN is false, so `dist < eps` does not reject NaN — it waves it
 *    through the guard that looks like it is rejecting it (#2441).
 *  - **A lower-bound floor rejects NaN but admits Infinity.** `len > 1e-10` is
 *    false for NaN and *true* for Infinity, and scaling infinite components by
 *    `1 / Infinity` is `Infinity * 0` — NaN. A guard written as
 *    `!Number.isNaN(...)` would pass every existing test and still be wrong.
 *  - **`Math.max`/`Math.min` are NaN-transparent.** `Math.max(0.01, NaN)` is
 *    `NaN`, not the floor, so a clamp forwards a malformed value rather than
 *    absorbing it.
 *
 * Every predicate here therefore keys on `Number.isFinite`, which is the only
 * test that rejects NaN and both infinities together.
 */

import type { Vec3 } from './types.js';

/**
 * Smallest orthographic half-height the projection matrix is ever built from.
 * Matches the floor the orthographic zoom clamps to in `CameraControls`.
 */
export const MIN_ORTHO_SIZE = 0.01;

/** Default orthographic half-height, in world units, and the neutral fallback. */
export const DEFAULT_ORTHO_SIZE = 50;

/**
 * Is `dist` a usable camera-to-target radius — finite, and at least `min` away
 * from zero so dividing by it means something?
 *
 * The navigation gestures all opened with a bare `dist < eps` early return.
 * That is a magnitude test, not a finiteness test, so a malformed pose walked
 * straight past it (#2441). Past the guard, the gesture writes its result into
 * `camera.position` *and* `camera.target`, so a single non-finite coordinate
 * (a BCF viewpoint restored from a file reaches the public setters
 * unvalidated) spreads across all six on the first drag.
 *
 * Callers keep their own fallback: there is no single substitute distance that
 * is right for all of them, which is also why `Camera.getDistance()` reports
 * the pose verbatim rather than sanitizing it centrally.
 */
export function isUsableDistance(dist: number, min: number): boolean {
  return Number.isFinite(dist) && dist >= min;
}

/**
 * Is `up` a usable screen-up reference — every component finite?
 *
 * `up` is the third vector of the pose, and it reaches the camera exactly the
 * way `position` and `target` do: BCF stores `CameraUpVector`, `bcfToViewerCoords`
 * only swaps axes, and `applyViewpoint` writes the result straight through
 * (`animateToWithUp` on the animated path — which bypasses `setUp` entirely —
 * or `setUp` on the instant one).
 *
 * Finiteness only, deliberately no magnitude floor. `normalize` already absorbs
 * a zero-length or degenerate `up` by returning `{0,0,0}`, and a *short* `up` is
 * a valid input whose direction is perfectly well defined — `MathUtils.lookAt`
 * documents the same thing and keys its own degeneracy test on the angle rather
 * than a length for exactly this reason. A floor here would silently drop the
 * cursor anchor for poses that navigate correctly today.
 *
 * The floor `normalize` used to have was a *lower* bound, which is what left
 * the gap: `len > 1e-10` is false for NaN (so a NaN `up` degraded safely to
 * the zero vector) but **true for Infinity**, and scaling infinite components
 * by `1 / Infinity` is `Infinity * 0` — NaN. Measured, not reasoned: `up`
 * `(Infinity, 1, 0)` on a finite pose came back from one cursor-anchored zoom
 * with position AND target `(NaN, NaN, NaN)`, in both projection modes (#2441).
 * Both copies of `normalize` now key that floor on `Number.isFinite` too
 * (#2479), so an unusable `up` reaches the same zero vector by either route —
 * this predicate says so at the top of the gesture rather than relying on a
 * helper's degradation three lines in, and it is what stops the *pose* being
 * rewritten from a basis that carries no orientation.
 *
 * As with {@link isUsableDistance}, the caller keeps its own fallback and the
 * pose is left exactly as it was found — `getUp()` still reports the malformed
 * vector, so a restored viewpoint is not silently rewritten on its way back out.
 */
export function isUsableUp(up: Vec3): boolean {
  return Number.isFinite(up.x) && Number.isFinite(up.y) && Number.isFinite(up.z);
}

/**
 * Clamp an orthographic half-height, rejecting a non-finite one.
 *
 * `Math.max`/`Math.min` are NaN-transparent, so a clamp alone does not stop a
 * malformed value reaching the projection matrix (#2441). Returns `null` when
 * there is no usable size, so the caller can keep the value it already had
 * rather than substitute an arbitrary one.
 *
 * The `Infinity` rejection is not theoretical: `orthoSize` is scaled in place
 * by the orthographic zoom, so a legitimately huge but finite half-height
 * overflows to `Infinity` after enough zoom-out notches, and
 * `Math.max(MIN_ORTHO_SIZE, Infinity)` is `Infinity`.
 */
export function usableOrthoSize(size: number): number | null {
  return Number.isFinite(size) ? Math.max(MIN_ORTHO_SIZE, size) : null;
}

/**
 * Are all of `values` finite?
 *
 * The gesture *arguments* — wheel deltas, pointer deltas, walk axes — are a
 * different input class from the pose the gestures already guard (#2473), and
 * they reach the same arithmetic. Measured on the pre-guard code: `orbit(NaN,
 * 0)`, `pan(NaN, 0)`, `zoom(NaN)` and `moveFirstPerson(NaN, 0, 0)` each turned
 * a perfectly finite pose into a non-finite one in a single call, and
 * `orbit(Infinity, 0)` / `pan(Infinity, 0)` / `moveFirstPerson(Infinity, 0, 0)`
 * did the same — the two do **not** behave alike everywhere, so both must be
 * tested. (`zoom` is the exception: its delta is clamped by
 * `Math.min(|delta| * s, MAX_ZOOM_DELTA)`, which absorbs `Infinity` but not
 * `NaN`.)
 */
export function areFiniteNumbers(...values: number[]): boolean {
  for (const v of values) {
    if (!Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Is this a usable cursor anchor — a finite cursor position inside a viewport
 * with a real extent?
 *
 * The cursor-anchored zoom divides by the canvas dimensions, so they need
 * `> 0` and not merely "truthy". Truthiness already rejects `0` and `NaN`
 * (both falsy) which is why a collapsed canvas never reached the division, but
 * it accepts `Infinity` and a negative width — the latter mirrors the anchor
 * and drifts the target the wrong way. `Number.isFinite(w) && w > 0` is the
 * check that means what the division needs.
 */
export function isUsableCursorAnchor(
  cursorX: number,
  cursorY: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    areFiniteNumbers(cursorX, cursorY, viewportWidth, viewportHeight) &&
    viewportWidth > 0 &&
    viewportHeight > 0
  );
}

/**
 * Is this AABB something the camera can be fitted to?
 *
 * Two rejections, and they are different failures:
 *
 *  - **Non-finite corners.** Fitting computes `center = (min + max) / 2` and
 *    `size = max - min`, and writes both into the pose. `Math.max` picking the
 *    largest extent is NaN-transparent, so one bad coordinate reaches
 *    `camera.position`, `camera.target` *and* (in orthographic mode)
 *    `orthoSize`, which `getOrthoSize()` then hands to a saved viewpoint —
 *    persisting the damage past the session (#2461).
 *  - **An inverted box** (`max < min` on any axis). That is the empty-AABB
 *    sentinel every accumulator in this package starts from (`min = +Infinity,
 *    max = -Infinity`) leaking out as if it were a real box, which is what a
 *    mesh with no finite vertices produces. Its centre is `NaN` and its size
 *    is negative; there is nothing to frame.
 *
 * A *degenerate* box (`max === min` on some or all axes — a flat wall, a
 * single point) is explicitly **not** rejected: it is a legitimate thing to
 * frame and `frameBounds` already centres on it.
 *
 * The answer to an unusable box is to reject the fit and leave the pose alone,
 * not to clamp: there is no meaningful substitute for an infinite or inverted
 * extent, and no previous bounds to fall back to at these entry points, which
 * are stateless. Keeping the pose the user already had is the same policy
 * `setAspect`, `setFOV` and `setOrthoSize` settled on (#2441/#2450).
 */
export function isUsableBounds(min: Vec3, max: Vec3): boolean {
  return (
    areFiniteNumbers(min.x, min.y, min.z, max.x, max.y, max.z) &&
    max.x >= min.x &&
    max.y >= min.y &&
    max.z >= min.z
  );
}
