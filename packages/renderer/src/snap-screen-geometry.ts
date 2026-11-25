/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Small geometry helpers of the screen-space corner search (#11504). */

import type { Vec3, Ray } from './raycaster.js';

/** Distance of (x, y, z) from the ray origin, measured along the ray direction. */
export function depthAlongRay(ray: Ray, x: number, y: number, z: number): number {
  return (x - ray.origin.x) * ray.direction.x + (y - ray.origin.y) * ray.direction.y + (z - ray.origin.z) * ray.direction.z;
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Squared distance from (px, py) to segment (ax, ay)-(bx, by). */
export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return (px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2;
}

/** The point of segment a-b nearest the ray's line (clamped to the segment). */
export function closestPointOnSegmentToRay(a: Vec3, b: Vec3, ray: Ray): Vec3 {
  const o = ray.origin, d = ray.direction;
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const wx = a.x - o.x, wy = a.y - o.y, wz = a.z - o.z;
  const uu = ux * ux + uy * uy + uz * uz;
  const dd = d.x * d.x + d.y * d.y + d.z * d.z;
  const ud = ux * d.x + uy * d.y + uz * d.z;
  const uw = ux * wx + uy * wy + uz * wz;
  const dw = d.x * wx + d.y * wy + d.z * wz;
  const denom = uu * dd - ud * ud;
  // Parallel to the ray: any point is as near, take the midpoint.
  const t = denom > 1e-12 * uu * dd ? Math.max(0, Math.min(1, (ud * dw - dd * uw) / denom)) : 0.5;
  return lerp(a, b, t);
}
