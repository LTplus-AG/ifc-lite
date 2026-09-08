/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry comparison primitives shared by the key-based pass (`diff.ts`) and
 * the content-keyed matching pass (`content-match.ts`).
 *
 * Everything here is bounding-box or hash arithmetic on the caller's own
 * numbers — no IFC knowledge, no store access.
 */

import type { EntityAabb, GeometryHash } from './types.js';

/**
 * A centre shift below this counts as tessellation / float noise, not a move.
 *
 * Deliberately the same value as `MOVE_EPS` in the viewer's
 * `apps/viewer/src/lib/compare/describeChange.ts`: it encodes issue #1197,
 * where a re-cut wall that never moved reported a phantom "moved 1.09 m". The
 * engine and the UI must draw that line in the same place, so the shared
 * origin is written down rather than left to coincidence.
 */
export const DEFAULT_MOVE_TOLERANCE = 2e-3;

/**
 * A per-axis bounding-box size change above this counts as a reshape.
 * Same origin as {@link DEFAULT_MOVE_TOLERANCE}: `RESHAPE_EPS` in
 * `describeChange.ts`.
 */
export const DEFAULT_RESHAPE_TOLERANCE = 1e-3;

/**
 * Maximum centre displacement at which two same-content entities may be paired
 * by position. Metres for a metre-scale model: a building-scale relocation
 * pairs, a cross-site teleport does not.
 */
export const DEFAULT_MAX_MOVE_DISTANCE = 10;

/** Resolved {@link DEFAULT_MOVE_TOLERANCE} & friends for one diff run. */
export interface GeometryTolerances {
  moveTolerance: number;
  reshapeTolerance: number;
  maxMoveDistance: number;
}

/** Non-finite or negative input falls back to the default rather than poisoning
 *  every comparison with `NaN` (an untyped JS caller can pass anything).
 *
 *  Exported for the split/merge settings, which face the same untyped caller
 *  and must coerce the same way — a second copy is a second place for one of
 *  the two to start believing a `NaN`. */
export function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveTolerances(options: {
  moveTolerance?: number;
  reshapeTolerance?: number;
  maxMoveDistance?: number;
}): GeometryTolerances {
  return {
    moveTolerance: positiveOr(options.moveTolerance, DEFAULT_MOVE_TOLERANCE),
    reshapeTolerance: positiveOr(options.reshapeTolerance, DEFAULT_RESHAPE_TOLERANCE),
    maxMoveDistance: positiveOr(options.maxMoveDistance, DEFAULT_MAX_MOVE_DISTANCE),
  };
}

/**
 * Compare two geometry fingerprints.
 *
 * - both `undefined`  → equal (neither side has geometry)
 * - one `undefined`   → changed (geometry added or removed)
 * - both present      → equal iff the normalized hashes match
 *
 * `bigint` and `string` hashes are normalized to strings so a `bigint` from
 * the WASM `BigUint64Array` compares equal to its string form.
 */
export function geometryEqual(
  a: GeometryHash | undefined,
  b: GeometryHash | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

/**
 * ABSTENTION — may geometry be used to classify anything in this diff?
 *
 * One revision fingerprinted by a build with geometry hashing on and the other
 * by a build with it off is a *capability* difference between two fingerprinting
 * runs, not a model change. {@link geometryEqual} reads every one-sided
 * `undefined` as "the geometry differs", so believing it would report the entire
 * model as changed: `modified`/`['geometry']` in the key-based pass, `moved` in
 * the content-keyed pass. When a whole side carries no geometry hashes at all
 * while the other does, neither pass uses geometry to classify anything.
 *
 * Both passes route through here so they cannot drift apart — a mixed-capability
 * pair of revisions must read the same way whichever pass sees the entity. (The
 * viewer keeps a `hasGeometryHashes` helper for the same reason.)
 *
 * A side "has geometry" if *any* participating entity carries a hash, so this
 * never fires on a model where only some entities are geometric: a single
 * entity that lost its geometry is still a real change, and stays one.
 */
export function resolveUseGeometry(
  considerGeometry: boolean,
  baseHasGeometry: boolean,
  headHasGeometry: boolean,
): boolean {
  return considerGeometry && baseHasGeometry === headHasGeometry;
}

/** A box is usable only if all six coordinates are real numbers; a box with a
 *  `NaN` in it would silently answer "different size" to every question. */
export function isUsableAabb(aabb: EntityAabb | undefined): aabb is EntityAabb {
  if (!aabb) return false;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(aabb.min[axis]) || !Number.isFinite(aabb.max[axis])) return false;
  }
  return true;
}

export type Vec3 = readonly [number, number, number];

export function aabbCentre(aabb: EntityAabb): Vec3 {
  return [
    (aabb.min[0] + aabb.max[0]) / 2,
    (aabb.min[1] + aabb.max[1]) / 2,
    (aabb.min[2] + aabb.max[2]) / 2,
  ];
}

export function centreDistance(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** True when the two boxes have the same extent on every axis within `tolerance`. */
export function sizeAgrees(a: EntityAabb, b: EntityAabb, tolerance: number): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const sizeA = a.max[axis] - a.min[axis];
    const sizeB = b.max[axis] - b.min[axis];
    if (Math.abs(sizeA - sizeB) > tolerance) return false;
  }
  return true;
}

/** How a pair whose geometry hash differs is described. */
export interface GeometryChange {
  kind: 'moved' | 'reshaped';
  /** Centre displacement, clamped to 0 below the move tolerance. Absent when
   *  no bounding box was available on one of the sides. */
  distance?: number;
}

/**
 * Classify a geometry-hash difference between two entities that content
 * matching has already decided are the same element.
 *
 * Without a bounding box on both sides there is nothing to reason with, so the
 * answer is the pre-#1891-follow-up one: `moved`, no distance.
 *
 * With boxes:
 * - different size on any axis → `reshaped` (a pure rigid move cannot change
 *   the axis-aligned extent... except by rotating it, which is why the
 *   distance still travels with the record for the caller to judge).
 * - same size, centre beyond `moveTolerance` → `moved`.
 * - same size and same centre, yet the hash differs → `reshaped` with distance
 *   0. This is what a reshape confined to the interior of the box looks like.
 *   A pure re-triangulation of an unchanged surface no longer reaches here at
 *   all — the geometry hash is retriangulation-invariant (see `geom_hash.rs`) —
 *   but a re-tessellation that introduces new vertices still does. An
 *   axis-aligned bounding box genuinely cannot separate those two, so this does
 *   not claim to: it reports the honest "the shape changed, it did not move".
 */
export function classifyGeometryChange(
  baseAabb: EntityAabb | undefined,
  headAabb: EntityAabb | undefined,
  tolerances: GeometryTolerances,
): GeometryChange {
  if (!isUsableAabb(baseAabb) || !isUsableAabb(headAabb)) return { kind: 'moved' };

  const rawDistance = centreDistance(aabbCentre(baseAabb), aabbCentre(headAabb));
  // Clamp sub-tolerance jitter to exactly 0, the way `describeChange.ts` does
  // for the key-matched path (issue #1197: "moved 1.09 m" on a wall that never
  // moved). A caller comparing `distance > 0` must not see float noise.
  const distance = rawDistance > tolerances.moveTolerance ? rawDistance : 0;

  if (!sizeAgrees(baseAabb, headAabb, tolerances.reshapeTolerance)) {
    return { kind: 'reshaped', distance };
  }
  if (distance > 0) return { kind: 'moved', distance };
  return { kind: 'reshaped', distance: 0 };
}
