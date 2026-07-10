/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from '../types.js';
import { Vec3 as PVec3 } from './generated/plato.g.js';

/**
 * Exact triangle–triangle intersection via the Separating Axis Theorem.
 *
 * Tests the 2 face normals plus the 9 edge–edge cross-product axes. Returns
 * `true` only when the triangle *interiors* overlap; bare touching (coincident
 * faces/edges/vertices) reports `false` and is handled by the distance path as
 * a `touch`. Coplanar overlap is intentionally treated as touching, not a hard
 * clash — genuine interpenetration always produces non-coplanar crossing
 * triangles, which the edge-cross axes separate correctly.
 *
 * The SAT itself lives once, in the single-source generated Vec3 kernel
 * (`TriTriIntersectEps`); this wrapper only marshals tuples into `Vec3`.
 */
export function triTriIntersect(
  a0: Vec3,
  a1: Vec3,
  a2: Vec3,
  b0: Vec3,
  b1: Vec3,
  b2: Vec3,
  eps = 1e-12,
): boolean {
  const v = (a: Vec3): PVec3 => new PVec3(a[0], a[1], a[2]);
  return v(a0).TriTriIntersectEps(v(a1), v(a2), v(b0), v(b1), v(b2), eps);
}
