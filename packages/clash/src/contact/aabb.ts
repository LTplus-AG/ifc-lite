/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, Vec3 } from "./types.js";

/** An empty AABB (inverted bounds); union with any AABB yields that AABB. */
export const EMPTY_AABB: AABB = {
  min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
};

/** True when two AABBs overlap (closed intervals). */
export function intersects(a: AABB, b: AABB): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** Smallest AABB containing both inputs. */
export function unionAabb(a: AABB, b: AABB): AABB {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Geometric centre of an AABB. */
export function center(a: AABB): Vec3 {
  return [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2];
}

/** Size (extent) of an AABB along each axis. */
export function size(a: AABB): Vec3 {
  return [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]];
}

/** True when the AABB contains the point (closed intervals). */
export function contains(a: AABB, p: Vec3): boolean {
  return (
    p[0] >= a.min[0] &&
    p[0] <= a.max[0] &&
    p[1] >= a.min[1] &&
    p[1] <= a.max[1] &&
    p[2] >= a.min[2] &&
    p[2] <= a.max[2]
  );
}

/** Inflate the AABB by `eps` on every face. Negative values deflate. */
export function inflate(a: AABB, eps: number): AABB {
  return {
    min: [a.min[0] - eps, a.min[1] - eps, a.min[2] - eps],
    max: [a.max[0] + eps, a.max[1] + eps, a.max[2] + eps],
  };
}

/** Build an AABB from a flat positions buffer (xyz, xyz, …). */
export function aabbFromPositions(positions: ArrayLike<number>): AABB {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    return EMPTY_AABB;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Longest axis of the AABB: 0=x, 1=y, 2=z. */
export function longestAxis(a: AABB): 0 | 1 | 2 {
  const [dx, dy, dz] = size(a);
  if (dx >= dy && dx >= dz) return 0;
  if (dy >= dz) return 1;
  return 2;
}
