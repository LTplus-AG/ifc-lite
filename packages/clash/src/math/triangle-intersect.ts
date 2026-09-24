/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from '../types.js';
import * as G from './generated/plato.g.js';

/**
 * Triangle–triangle intersection via the Separating Axis Theorem.
 *
 * Tests the 2 face normals plus the 9 edge–edge cross-product axes. Returns
 * `true` only when the triangle *interiors* overlap by more than the f32
 * quantisation noise of the six vertices; touching (coincident or coplanar
 * faces, an edge or vertex on a face) reports `false` — including when the
 * contact is off by that noise, as flush surfaces from f32 buffers usually
 * are (#5406) — and is handled by the distance path as a `touch`. The band is
 * per coordinate axis and projected onto each tested axis, so an axis
 * orthogonal to it contributes nothing however far from the origin the pair
 * sits.
 *
 * `eps` bounds sin² of the angle between two edges below which their cross
 * product is too degenerate to use as an axis (relative, so scale-free).
 *
 * The SAT itself lives once, in the single-source generated kernel; this
 * wrapper binds the flattened tuple-native form (zero per-call allocation).
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
  return G.triTriIntersect(a0, a1, a2, b0, b1, b2, eps);
}
