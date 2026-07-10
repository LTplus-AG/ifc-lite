/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Tuple/AABB-API surface over the Plato-generated Box3 kernel
 * (generated/plato.g.ts). Public signatures are unchanged: every function takes
 * and returns `AABB` ({ min, max } tuples). The box math lives once, in the
 * single-source generated class; this module only marshals AABB <-> Box3.
 *
 * `fromPositions` is deliberately kept hand-written: it is genuinely
 * buffer-shaped (a single strided walk over a packed Float32Array), not a
 * Box3-algebra expression. */

import type { AABB } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';
import { Box3 as PBox3, Vec3 as PVec3 } from './generated/plato.g.js';

function v(a: Vec3): PVec3 {
  return new PVec3(a[0], a[1], a[2]);
}

function tuple(p: PVec3): Vec3 {
  return [p.X, p.Y, p.Z];
}

function box(b: AABB): PBox3 {
  return new PBox3(v(b.min), v(b.max));
}

function toAABB(b: PBox3): AABB {
  return { min: tuple(b.Min), max: tuple(b.Max) };
}

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
  return toAABB(box(b).Inflate(m));
}

export function center(b: AABB): Vec3 {
  return tuple(box(b).Center());
}

export function intersects(a: AABB, b: AABB): boolean {
  return box(a).Intersects(box(b));
}

/**
 * Signed gap between two boxes: `>0` is the Euclidean separation, `<0` is the
 * penetration depth (negative of the minimum-axis overlap). Used as a cheap
 * penetration *estimate* for hard clashes in the Phase-0 reference engine;
 * exact penetration depth lands with the Rust core.
 */
export function signedGap(a: AABB, b: AABB): number {
  return box(a).SignedGap(box(b));
}

/** The intersection box of two overlapping bounds (clamped to be non-inverted). */
export function overlapBounds(a: AABB, b: AABB): AABB {
  return toAABB(box(a).OverlapBounds(box(b)));
}

/** Bounds enclosing two points. */
export function boundsOfPoints(a: Vec3, b: Vec3): AABB {
  return toAABB(v(a).BoundsOfPoints(v(b)));
}

/**
 * True when `outer` fully contains `inner` (face-sharing counts as contained).
 * Cheap precondition for the enclosed-solid test in the narrow phase: a solid
 * can only be buried inside another if its AABB is inside the other's. Mirrors
 * `aabb_contains` in the Rust kernel exactly (same `<=`/`>=`, axis order 0,1,2).
 */
export function aabbContains(outer: AABB, inner: AABB): boolean {
  return box(outer).Contains(box(inner));
}
