/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plane utilities. A plane is stored as a unit normal + signed offset:
 *   normal · x = offset
 * `canonicalPlane` produces a direction-independent key so that the pair
 * (normal, -normal, offset, -offset) hashes identically.
 */

import type { Vec3 } from "./types.js";
import { dot3, length3 } from "./vec3.js";

export interface Plane {
  readonly normal: Vec3;
  readonly offset: number;
}

export interface PlaneBasis {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
}

/** Build a plane from a normal (not required to be unit) and a point on it. */
export function planeFromNormalPoint(normal: Vec3, point: Vec3): Plane {
  const ln = length3(normal);
  if (ln === 0) return { normal: [0, 0, 1], offset: 0 };
  const n: Vec3 = [normal[0] / ln, normal[1] / ln, normal[2] / ln];
  return { normal: n, offset: dot3(n, point) };
}

/**
 * Direction-independent quantised plane key.
 *
 * The normal is reflected so its first nonzero component is positive,
 * then rounded to `angleSnap` radians in spherical form. The offset is
 * signed accordingly and rounded to `distSnap` world units.
 */
export function planeKey(plane: Plane, angleSnap = 1e-3, distSnap = 1e-3): string {
  const n = plane.normal;
  const ln = length3(n);
  if (ln === 0) return "0|0|0|0";
  // Canonicalise direction: first nonzero coordinate must be positive.
  let sign = 1;
  if (Math.abs(n[0]) > 1e-9) sign = n[0] > 0 ? 1 : -1;
  else if (Math.abs(n[1]) > 1e-9) sign = n[1] > 0 ? 1 : -1;
  else sign = n[2] > 0 ? 1 : -1;
  const cx = (n[0] / ln) * sign;
  const cy = (n[1] / ln) * sign;
  const cz = (n[2] / ln) * sign;
  const off = plane.offset * sign;
  return [
    Math.round(cx / angleSnap),
    Math.round(cy / angleSnap),
    Math.round(cz / angleSnap),
    Math.round(off / distSnap),
  ].join("|");
}

/**
 * Build an orthonormal basis `{u, v}` in the plane so 3D plane points can
 * be projected to 2D and back. `origin` is chosen as the foot of the normal
 * from the world origin.
 */
export function planeBasis(plane: Plane): PlaneBasis {
  const n = plane.normal;
  // origin = offset * n (foot of normal from world origin if |n|=1)
  const origin: Vec3 = [n[0] * plane.offset, n[1] * plane.offset, n[2] * plane.offset];
  // pick a helper not parallel to n
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0: Vec3 = [
    helper[1] * n[2] - helper[2] * n[1],
    helper[2] * n[0] - helper[0] * n[2],
    helper[0] * n[1] - helper[1] * n[0],
  ];
  const uLen = length3(u0);
  const u: Vec3 = uLen === 0 ? [1, 0, 0] : [u0[0] / uLen, u0[1] / uLen, u0[2] / uLen];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { origin, u, v, normal: n };
}

/** Project a 3D point onto the plane's 2D basis. */
export function projectTo2D(basis: PlaneBasis, p: Vec3): readonly [number, number] {
  const dx = p[0] - basis.origin[0];
  const dy = p[1] - basis.origin[1];
  const dz = p[2] - basis.origin[2];
  return [
    dx * basis.u[0] + dy * basis.u[1] + dz * basis.u[2],
    dx * basis.v[0] + dy * basis.v[1] + dz * basis.v[2],
  ];
}

/** Lift a 2D basis point back to 3D. */
export function liftTo3D(basis: PlaneBasis, p: readonly [number, number]): Vec3 {
  return [
    basis.origin[0] + basis.u[0] * p[0] + basis.v[0] * p[1],
    basis.origin[1] + basis.u[1] * p[0] + basis.v[1] * p[1],
    basis.origin[2] + basis.u[2] * p[0] + basis.v[2] * p[1],
  ];
}
