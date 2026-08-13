/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Numeric boundary helpers for BCF.
 *
 * A `.bcfzip` is an untrusted file, and every number in it arrives through a
 * bare `parseFloat`. `parseFloat` has no failure value that is out of band:
 * `"NaN"` parses to `NaN`, and `"1e999"` — a perfectly well-formed decimal
 * literal — parses to `Infinity`. Both then flow into the viewer camera, which
 * stores a pose verbatim by design.
 */

/**
 * `parseFloat`, but a value that is not a real number is reported as
 * `undefined` rather than as `NaN`/`Infinity`.
 *
 * `undefined` is deliberately the *same* signal the parsers already use for
 * "this element is missing", so every call site handles it already: a camera
 * with an unusable coordinate is dropped exactly as a camera with no
 * `<CameraViewPoint>` is, a clipping plane is skipped exactly as one with no
 * `<Location>` is. That is what makes validating at the parser cheap — it adds
 * no new branch anywhere — and it is why this is the boundary the fix belongs
 * at rather than the six app-layer consumers downstream, which is the
 * arrangement that let the gap open in the first place.
 */
export function parseFiniteFloat(raw: string): number | undefined {
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * A caller-supplied camera-to-target distance, or `fallback` when it is not a
 * usable one.
 *
 * The viewer passes `camera.getDistance()` here, and that is raw by design:
 * `@ifc-lite/renderer` reports a malformed pose rather than hiding it, so a
 * pose already broken by some other route arrives as `NaN`. The conversions
 * that take this value compute `target = viewPoint + direction * distance` and
 * the result is written back into the camera — so *restoring a known-good
 * viewpoint*, the one action a user reaches for after the camera has gone
 * wrong, was the thing that could not repair it. Falling back to the
 * documented default here makes the restore land on a finite pose, which is
 * recoverable, and it needs one guard rather than one per consumer.
 *
 * Zero is rejected along with the non-finite values: a zero reference distance
 * collapses the target onto the eye, which is a degenerate pose in its own
 * right (`getDistance()` returns exactly 0 for it, and it is what a camera
 * that has never been positioned reports).
 */
export function usableTargetDistance(distance: number | undefined, fallback: number): number {
  return distance !== undefined && Number.isFinite(distance) && distance > 0 ? distance : fallback;
}
