/* Tuple-API adapter over the Plato-generated clash math (plato.g.ts).
 *
 * Exposes the SAME signatures as the hand-written originals
 * (packages/clash/src/math/{vec3,aabb,triangle-intersect}.ts) but every
 * operation is delegated to the generated Vec3 / Box3 classes. Nothing here
 * re-implements the math; it only marshals tuple <-> Vec3 and AABB <-> Box3.
 *
 * Importing plato.g.ts also installs the Number/Boolean prototype intrinsics
 * (Add, Subtract, Max2, FoldMin, ...) that the generated methods rely on. */

import type { Vec3, AABB } from './types.js';
import { Vec3 as PVec3, Box3 as PBox3 } from './plato.g.js';

// ---- marshalling helpers ----
function v(a: Vec3): PVec3 {
  return new PVec3(a[0], a[1], a[2]);
}
function toTuple(p: PVec3): Vec3 {
  return [p.X, p.Y, p.Z];
}
function box(b: AABB): PBox3 {
  return new PBox3(v(b.min), v(b.max));
}
function toAABB(b: PBox3): AABB {
  return { min: toTuple(b.Min), max: toTuple(b.Max) };
}

// ---- vec3 primitives ----
export function sub(a: Vec3, b: Vec3): Vec3 {
  return toTuple(v(a).Sub(v(b)));
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return toTuple(v(a).Add(v(b)));
}

export function scale(a: Vec3, s: number): Vec3 {
  return toTuple(v(a).Scale(s));
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return toTuple(v(a).Cross(v(b)));
}

export function dot(a: Vec3, b: Vec3): number {
  return v(a).Dot(v(b));
}

export function lenSq(a: Vec3): number {
  return v(a).LenSq();
}

export function distSq(a: Vec3, b: Vec3): number {
  return v(a).DistSq(v(b));
}

export function mid(a: Vec3, b: Vec3): Vec3 {
  return toTuple(v(a).Mid(v(b)));
}

export function centroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return toTuple(v(a).Centroid(v(b), v(c)));
}

// ---- aabb / box primitives ----
export function inflate(b: AABB, m: number): AABB {
  return toAABB(box(b).Inflate(m));
}

export function center(b: AABB): Vec3 {
  return toTuple(box(b).Center());
}

export function intersects(a: AABB, b: AABB): boolean {
  return box(a).Intersects(box(b));
}

export function signedGap(a: AABB, b: AABB): number {
  return box(a).SignedGap(box(b));
}

export function overlapBounds(a: AABB, b: AABB): AABB {
  return toAABB(box(a).OverlapBounds(box(b)));
}

export function boundsOfPoints(a: Vec3, b: Vec3): AABB {
  return toAABB(v(a).BoundsOfPoints(v(b)));
}

export function aabbContains(outer: AABB, inner: AABB): boolean {
  return box(outer).Contains(box(inner));
}

// ---- triangle-triangle SAT ----
export function triTriIntersect(
  a0: Vec3,
  a1: Vec3,
  a2: Vec3,
  b0: Vec3,
  b1: Vec3,
  b2: Vec3,
  eps = 1e-12,
): boolean {
  return v(a0).TriTriIntersectEps(v(a1), v(a2), v(b0), v(b1), v(b2), eps);
}
