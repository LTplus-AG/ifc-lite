/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared math for the arbitrary-normal section plane.
 *
 * Both the viewer's face-pick handler and the renderer (shader clip +
 * gizmo quad) need the same mapping from a world-space plane normal + a
 * 0-100% slider to a world-space plane distance. Duplicating the math in
 * three places drifted the last time it changed — this module is the
 * single source of truth.
 *
 * The mapping is:
 *   1. Project the 8 AABB corners of the model bounds onto the unit
 *      normal. The min/max of those projections define the range of
 *      plane distances that touch the model.
 *   2. The slider's `position` (0-100%) interpolates inside that range.
 *
 * For a cardinal normal (e.g. `[0, 1, 0]` = down) this reduces to the
 * classic "slider from min Y to max Y" behaviour, so the axis-preset
 * path can use the same helper if it wants — but doesn't have to, since
 * the axis presets precede this work and have their own logic that also
 * honours an optional UI-supplied storey range.
 */

export interface SectionBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Project a model AABB onto a unit normal and return the min/max/range
 * of signed plane distances (`dot(corner, normal)`) across all 8 corners.
 *
 * `normal` must be approximately unit length; the callers in this codebase
 * normalise before calling. For `range < 1e-6` (degenerate bounds, e.g.
 * an empty scene) consumers should treat the plane as sitting at `min`.
 */
export function projectBoundsOntoNormal(
  bounds: SectionBounds,
  normal: readonly [number, number, number],
): { min: number; max: number; range: number } {
  const { min, max } = bounds;
  let minP = Infinity;
  let maxP = -Infinity;
  for (const cx of [min.x, max.x]) {
    for (const cy of [min.y, max.y]) {
      for (const cz of [min.z, max.z]) {
        const pr = cx * normal[0] + cy * normal[1] + cz * normal[2];
        if (pr < minP) minP = pr;
        if (pr > maxP) maxP = pr;
      }
    }
  }
  return { min: minP, max: maxP, range: maxP - minP };
}

/**
 * Convert a slider position (0-100%) to a world-space plane distance
 * along `normal`, mapped against the model AABB's projected range.
 * Degenerate bounds (range ≈ 0) collapse to `min`.
 */
export function planeDistanceForPosition(
  bounds: SectionBounds,
  normal: readonly [number, number, number],
  position: number,
): number {
  const { min, range } = projectBoundsOntoNormal(bounds, normal);
  if (range < 1e-6) return min;
  const t = Math.min(100, Math.max(0, position)) / 100;
  return min + t * range;
}

/**
 * Inverse mapping: given a world-space point on the plane (typically a
 * raycast hit), return the slider position (0-100%) that would place the
 * plane through it. Used by face-pick so the slider immediately reflects
 * where the user clicked.
 */
export function positionFromPoint(
  bounds: SectionBounds,
  normal: readonly [number, number, number],
  point: readonly [number, number, number],
): number {
  const { min, range } = projectBoundsOntoNormal(bounds, normal);
  if (range < 1e-6) return 50;
  const proj = point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2];
  return Math.min(100, Math.max(0, ((proj - min) / range) * 100));
}
