/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from '../types.js';
import { cross, dot, sub } from './vec3.js';

/**
 * Exact triangle–triangle intersection via the Separating Axis Theorem.
 *
 * Tests the 2 face normals plus the 9 edge–edge cross-product axes. Returns
 * `true` only when the triangle *interiors* overlap; bare touching (coincident
 * faces/edges/vertices) reports `false` and is handled by the distance path as
 * a `touch`. Coplanar overlap is intentionally treated as touching, not a hard
 * clash — genuine interpenetration always produces non-coplanar crossing
 * triangles, which the edge-cross axes separate correctly.
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
  const edgesA: Vec3[] = [sub(a1, a0), sub(a2, a1), sub(a0, a2)];
  const edgesB: Vec3[] = [sub(b1, b0), sub(b2, b1), sub(b0, b2)];

  const axes: Vec3[] = [cross(edgesA[0], edgesA[1]), cross(edgesB[0], edgesB[1])];
  for (const ea of edgesA) {
    for (const eb of edgesB) {
      const axis = cross(ea, eb);
      if (dot(axis, axis) > eps) {
        axes.push(axis);
      }
    }
  }

  const va: Vec3[] = [a0, a1, a2];
  const vb: Vec3[] = [b0, b1, b2];

  for (const axis of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const v of va) {
      const p = dot(v, axis);
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }
    for (const v of vb) {
      const p = dot(v, axis);
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }
    // `<=` so exact contact counts as separation (touch), not interpenetration.
    if (maxA <= minB || maxB <= minA) {
      return false;
    }
  }

  return true;
}
