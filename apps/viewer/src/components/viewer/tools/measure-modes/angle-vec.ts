/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vector primitives shared by the angle measurement modes (#2735).
 *
 * Deliberately local rather than pulled from a maths library: these operate on
 * the same plain `{x,y,z}` shape `polyline.ts` already uses for picked points,
 * so the angle modules stay pure display maths over stored picks - the
 * `inclination.ts` precedent - with nothing to mock and no renderer types in
 * the test surface.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export function sub(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function norm(v: Point3): number {
  return Math.sqrt(dot(v, v));
}

/** Unit vector, or `null` when the input has no direction to normalise. */
export function normalize(v: Point3): Point3 | null {
  const n = norm(v);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/**
 * Angle between two vectors in degrees, in [0, 180].
 *
 * `atan2(|a x b|, a . b)`, NOT `acos(a . b)`, and the reason is NaN rather
 * than precision.
 *
 * MEASURED: normalising an f32-derived vector leaves its own self-dot up to
 * ~6.7e-16 ABOVE 1, because `x/n` rounds independently per component. `acos`
 * returns NaN outside [-1, 1], so this is not a tail risk - sampling 200k
 * f32 direction vectors produced 44,915 NaNs. A concrete reproducible case,
 * pinned in the sibling test:
 *
 *     v = { 0.010309278033673763, 0.02247191034257412, 0.022900763899087906 }
 *     dot(normalize(v), normalize(v)) = 1.0000000000000002   ->  acos = NaN
 *
 * It bites hardest for near-parallel rays, which is exactly what `zero` and
 * `straight` exist to classify - so the degenerate cases would poison the
 * common ones. `atan2` has no such domain restriction.
 *
 * Precision is NOT the argument, and claiming it would overstate the case:
 * measured against exact values, `acos`'s error peaks around 2.7e-9 degrees
 * near 0 and 180 - invisible at the one decimal these readouts render.
 *
 * Inputs need not be unit length; the ratio form is scale-invariant.
 */
export function angleBetweenDeg(a: Point3, b: Point3): number {
  return (Math.atan2(norm(cross(a, b)), dot(a, b)) * 180) / Math.PI;
}
