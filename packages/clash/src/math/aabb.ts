/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';

/** Transform a point by a column-major 4×4 matrix. */
function applyMat4(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Axis-aligned bounds of a packed `[x,y,z,...]` position buffer. */
export function fromPositions(positions: Float32Array, transform?: Mat4): AABB {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    let x = positions[i];
    let y = positions[i + 1];
    let z = positions[i + 2];
    if (transform) {
      [x, y, z] = applyMat4(transform, x, y, z);
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Expand bounds by `m` on every side. */
export function inflate(b: AABB, m: number): AABB {
  return {
    min: [b.min[0] - m, b.min[1] - m, b.min[2] - m],
    max: [b.max[0] + m, b.max[1] + m, b.max[2] + m],
  };
}

export function center(b: AABB): Vec3 {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

export function intersects(a: AABB, b: AABB): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

/**
 * Signed gap between two boxes: `>0` is the Euclidean separation, `<0` is the
 * penetration depth (negative of the minimum-axis overlap). Used as a cheap
 * penetration *estimate* for hard clashes in the Phase-0 reference engine;
 * exact penetration depth lands with the Rust core.
 */
export function signedGap(a: AABB, b: AABB): number {
  let squaredDistance = 0;
  let minOverlap = Infinity;
  let penetrating = true;
  for (let i = 0; i < 3; i += 1) {
    const gap = Math.max(b.min[i] - a.max[i], a.min[i] - b.max[i]);
    if (gap > 0) {
      squaredDistance += gap * gap;
      penetrating = false;
    } else {
      const overlap = Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
      if (overlap < minOverlap) minOverlap = overlap;
    }
  }
  return penetrating ? -minOverlap : Math.sqrt(squaredDistance);
}

/** The intersection box of two overlapping bounds (clamped to be non-inverted). */
export function overlapBounds(a: AABB, b: AABB): AABB {
  const min: Vec3 = [
    Math.max(a.min[0], b.min[0]),
    Math.max(a.min[1], b.min[1]),
    Math.max(a.min[2], b.min[2]),
  ];
  const max: Vec3 = [
    Math.min(a.max[0], b.max[0]),
    Math.min(a.max[1], b.max[1]),
    Math.min(a.max[2], b.max[2]),
  ];
  for (let i = 0; i < 3; i += 1) {
    if (max[i] < min[i]) {
      const mid = (min[i] + max[i]) / 2;
      min[i] = mid;
      max[i] = mid;
    }
  }
  return { min, max };
}

/** Bounds enclosing two points. */
export function boundsOfPoints(a: Vec3, b: Vec3): AABB {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/**
 * True when `outer` fully contains `inner` (face-sharing counts as contained).
 * Cheap precondition for the enclosed-solid test in the narrow phase: a solid
 * can only be buried inside another if its AABB is inside the other's. Mirrors
 * `aabb_contains` in the Rust kernel exactly (same `<=`/`>=`, axis order 0,1,2).
 */
export function aabbContains(outer: AABB, inner: AABB): boolean {
  return (
    outer.min[0] <= inner.min[0] && outer.max[0] >= inner.max[0] &&
    outer.min[1] <= inner.min[1] && outer.max[1] >= inner.max[1] &&
    outer.min[2] <= inner.min[2] && outer.max[2] >= inner.max[2]
  );
}
