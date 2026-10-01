/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CustomSectionPlane } from '../types';

/**
 * Project `pickedAt` onto the current cut plane and return that point as
 * the "anchor on the live plane".
 *
 * The plane equation is `dot(p, normal) = distance`. As the user drags
 * the gizmo (or moves the slider) only `distance` changes — `pickedAt`
 * stays at the original face-pick location, which sits OFF the live
 * plane. Any visual that needs a "point on the current plane" (cap
 * polygon basis origin, 3D drag gizmo position, hatch UV anchor) must
 * use the projected point instead, otherwise it freezes at the original
 * pick location while the actual cut slides along the normal.
 *
 * Derivation: the projection of `pickedAt` onto the plane is
 * `pickedAt + (distance − dot(pickedAt, normal)) · normal`, which moves
 * `pickedAt` along the unit normal by exactly the offset required to
 * satisfy `dot(out, normal) = distance`.
 *
 * Round-trip note: when `distance == dot(pickedAt, normal)` (i.e. just
 * after a fresh face-pick) the result equals `pickedAt`, so the legacy
 * code path that fed `pickedAt` directly is preserved at pick-time.
 */
export function customPlaneCenter(plane: CustomSectionPlane): [number, number, number] {
  const { pickedAt: p, normal: n, distance: d } = plane;
  const dotPicked = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const k = d - dotPicked;
  return [p[0] + k * n[0], p[1] + k * n[1], p[2] + k * n[2]];
}
