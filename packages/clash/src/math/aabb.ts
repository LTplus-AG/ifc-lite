/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* AABB-API surface over the Plato-generated box kernel (generated/plato.g.ts).
 * Public signatures are unchanged. The box math lives once, in the
 * single-source generated code; these wrappers bind the flattened tuple-native
 * kernels (zero per-call allocation) to the crate's `AABB` type.
 *
 * `fromPositions` is deliberately kept hand-written: it is genuinely
 * buffer-shaped (a single strided walk over a packed Float32Array), not a
 * box-algebra expression. */

import type { AABB } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';
import * as G from './generated/plato.g.js';

/** Transform a point by a column-major 4×4 matrix. */
function applyMat4(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Thrown by {@link fromPositions} when every vertex is non-finite on at least
 * one axis, so the axis has nothing finite to bound. Returning the box
 * inverted (`min > max`) on that axis — as older revisions of this function
 * did — is not a safe fallback: `boxesTouch` (`duplicate-metric.ts`) is only
 * reached from the duplicates pass, not from the BVH broad phase
 * (`@ifc-lite/spatial`) that `engine-ts/broad.ts` builds from `ClashElement.
 * bounds`. There, an inverted box fails `min <= queryMax && max >= queryMin`
 * on every query, so the element silently drops out of every spatial query —
 * including the ones that would have found a genuine hard clash (#4254).
 * Callers own the recovery: {@link fromPositions} cannot skip-and-report on
 * its own (it has no element identity), so `step.ts` / `ifcx.ts` catch this,
 * skip the one occurrence, and count+warn — the same shape as their existing
 * `missingGlobalIds` handling — rather than aborting the whole clash run for
 * one corrupt element among many.
 */
export class NonFiniteAxisError extends Error {
  readonly axes: readonly ('x' | 'y' | 'z')[];
  readonly vertexCount: number;

  constructor(axes: readonly ('x' | 'y' | 'z')[], vertexCount: number) {
    super(
      `fromPositions: every vertex is non-finite on axis ${axes.join(', ')} ` +
        `(${vertexCount} vertices scanned) — refusing to return an inverted ` +
        `(min > max) box, which would silently drop this geometry from every ` +
        `spatial query`,
    );
    this.name = 'NonFiniteAxisError';
    this.axes = axes;
    this.vertexCount = vertexCount;
  }
}

/**
 * Axis-aligned bounds of a packed `[x,y,z,...]` position buffer.
 *
 * Non-finite coordinates (NaN and ±Infinity, checked after `transform` is
 * applied) never become bounds: an infinite bound makes `boxDistance` return
 * NaN, and a NaN distance passes every comparison-shaped gate downstream. The
 * finite coordinates of a partly poisoned vertex still count — the rule is
 * per coordinate, not per vertex.
 *
 * If NO vertex contributes a finite coordinate on some axis, there is no
 * finite bound to report on that axis at all: this throws
 * {@link NonFiniteAxisError} naming the axis rather than returning the box
 * inverted (`min > max`) on it. An inverted box is not "rejected" anywhere on
 * the path that matters — `@ifc-lite/spatial`'s `BVH.build`/`queryAABB`
 * (reached via `engine-ts/broad.ts`) has no such check, so it would silently
 * make the element invisible to every spatial query instead (#4254).
 */
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
    // Only finite coordinates may become bounds. NaN was already excluded as a
    // side effect (it fails both `<` and `>`), but ±Infinity propagated, and an
    // infinite bound turns `boxDistance` into NaN — which `boxesTouch` passes.
    // The rule is per coordinate, matching what NaN already got: the finite
    // coordinates of a partly poisoned vertex still count.
    if (Number.isFinite(x)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (Number.isFinite(y)) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (Number.isFinite(z)) {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  // minX/maxX (etc.) only ever move together: the first finite coordinate
  // seen on an axis sets both `< minX` and `> maxX` against itself, so a
  // sentinel still sitting at ±Infinity here means NOT ONE vertex contributed
  // a finite value on that axis — checking `min` alone is exhaustive.
  const badAxes: ('x' | 'y' | 'z')[] = [];
  if (minX === Infinity) badAxes.push('x');
  if (minY === Infinity) badAxes.push('y');
  if (minZ === Infinity) badAxes.push('z');
  if (badAxes.length > 0) {
    throw new NonFiniteAxisError(badAxes, Math.floor(positions.length / 3));
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Expand bounds by `m` on every side. */
export function inflate(b: AABB, m: number): AABB {
  return G.inflate(b, m);
}

export function center(b: AABB): Vec3 {
  return G.center(b);
}

export function intersects(a: AABB, b: AABB): boolean {
  return G.intersects(a, b);
}

/**
 * Signed gap between two boxes: `>0` is the Euclidean separation, `<0` is the
 * penetration depth (negative of the minimum-axis overlap). Used as a cheap
 * penetration *estimate* for hard clashes in the Phase-0 reference engine;
 * exact penetration depth lands with the Rust core.
 */
export function signedGap(a: AABB, b: AABB): number {
  return G.signedGap(a, b);
}

/** The intersection box of two overlapping bounds (clamped to be non-inverted). */
export function overlapBounds(a: AABB, b: AABB): AABB {
  return G.overlapBounds(a, b);
}

/** Bounds enclosing two points. */
export function boundsOfPoints(a: Vec3, b: Vec3): AABB {
  return G.boundsOfPoints(a, b);
}

/**
 * True when `outer` fully contains `inner` (face-sharing counts as contained).
 * Cheap precondition for the enclosed-solid test in the narrow phase: a solid
 * can only be buried inside another if its AABB is inside the other's. Mirrors
 * `aabb_contains` in the Rust kernel exactly (same `<=`/`>=`, axis order 0,1,2).
 */
export function aabbContains(outer: AABB, inner: AABB): boolean {
  return G.aabbContains(outer, inner);
}
