/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ray <-> point-cloud local-frame conversion for snap queries.
 *
 * ## Why this exists
 *
 * Two features landed independently and left a gap between them:
 *
 * - #1804 gives each point-cloud node a per-asset model matrix
 *   (`PointCloudNode.model`) applied at RENDER time — the shader places
 *   points through it, and `transformAabb` folds it into reported bounds.
 * - #1860 built the snap/measure spatial index, which stores RAW,
 *   untransformed chunk positions straight off the decoder.
 *
 * So for a georeferenced (aligned) scan the renderer draws points at
 * aligned positions while the snap query walks an index of pre-alignment
 * positions: a measurement snapped to where the point USED to be, not
 * where the user can see it. Both features are individually correct; the
 * defect only exists in their composition, which is why neither PR's tests
 * caught it.
 *
 * ## Why the ray moves, not the points
 *
 * We inverse-transform the ray into the node's local frame rather than
 * transforming candidate points into world space:
 *
 * - The index's cell keys are packed RELATIVE to the first indexed point
 *   and are only meaningful in local space — transforming points would
 *   invalidate the whole acceleration structure.
 * - It is O(1) per node instead of O(points-examined).
 *
 * ## Distances stay in world units
 *
 * `queryRay` treats `t` as a distance along a UNIT direction and compares
 * `toleranceAt(t)` as a perpendicular radius, both in the index's own
 * space. Under a matrix with scale `s`, a world distance `d` is a local
 * distance `d / s`. Every distance-valued quantity therefore has to be
 * converted on the way in and back on the way out:
 *
 *   maxDistance_local = maxDistance_world / s
 *   toleranceAt_local(t_local) = toleranceAt_world(t_local * s) / s
 *   distance_world = distance_local * s
 *
 * Get this wrong and the ~8px screen-space snap tolerance silently means
 * something different on any scan whose CRS is not in metres (a foot-based
 * CRS carries s = 0.3048), which would read as "snapping feels wrong on
 * US survey-foot projects" — the sort of bug that is very hard to trace
 * back to a matrix.
 *
 * The alignment matrices this handles are similarity transforms (uniform
 * scale * rotation about Y, zero translation — see `pointCloudAlignment`),
 * so a single scalar `s` is exact. `matrixUniformScale` falls back to the
 * mean column length for anything else, which keeps a non-uniform matrix
 * approximately right rather than wildly wrong.
 *
 * ## Known limit: long-range reach under a sub-unit scale
 *
 * `PointCloudSpatialIndex` caps its per-step dilation at
 * `MAX_DILATION_RADIUS_CELLS * cellSize` = 2 LOCAL units, a deliberate
 * bound on march cost. Because the tolerance is converted into local
 * units, a matrix with `s < 1` tightens that cap in world terms: a
 * foot-based CRS (`s = 0.3048`) caps the effective snap radius at
 * `2 * 0.3048 = 0.61 m` rather than 2 m, so at long range a point inside
 * the nominal ~8px tolerance can sit outside the searched cells and be
 * missed.
 *
 * This is a reach limit, not a wrong answer: whatever the query returns is
 * correctly placed, and near-to-mid range (where measuring actually
 * happens) is unaffected. Restoring the full world-space reach means
 * scaling the cap to `MAX_DILATION_RADIUS_CELLS / s` (~14 cells at
 * s = 0.3048), which re-inflates the per-step probe cost that the
 * leading-slab bound exists to contain — a perf trade that should be made
 * deliberately, with a benchmark, rather than folded into this fix.
 */

import { MathUtils } from '../math.js';
import type { Vec3 } from '../raycaster.js';
import { isUsableModelMatrix } from './point-cloud-node.js';

/** The subset of a `PointCloudNode` the snap-source snapshot reads. */
export interface RayQueryNodeLike {
  meta: { expressId: number; modelIndex?: number };
  spatialIndex: { pointCount: number };
  model?: Float32Array;
}

/** One entry of the snapshot handed to `queryPointClouds`. */
export interface RayQuerySource<TNode extends RayQueryNodeLike> {
  expressId: number;
  modelIndex?: number;
  index: TNode['spatialIndex'];
  classMask: Uint32Array;
  model?: Float32Array;
}

/**
 * Build the snap-query snapshot from live nodes.
 *
 * Pure and node-shaped rather than inlined in `PointCloudRenderer` so it is
 * testable without a `GPUDevice`. That matters here specifically: the
 * renderer-to-query wiring is exactly where the aligned-scan gap lived, and
 * it went unnoticed because nothing could exercise it without a GPU. Empty
 * nodes are skipped, mirroring `getPickNodes`.
 */
export function buildRayQuerySources<TNode extends RayQueryNodeLike>(
  nodes: Iterable<TNode>,
  classMask: Uint32Array,
): Array<RayQuerySource<TNode>> {
  const out: Array<RayQuerySource<TNode>> = [];
  for (const node of nodes) {
    if (node.spatialIndex.pointCount === 0) continue;
    out.push({
      expressId: node.meta.expressId,
      modelIndex: node.meta.modelIndex,
      index: node.spatialIndex,
      // The index stores RAW decoder positions while the shader draws
      // through `model` (#1804) — the query needs the matrix to reconcile
      // the two, or an aligned scan snaps to pre-alignment coordinates.
      model: node.model,
      classMask,
    });
  }
  return out;
}

/** A ray rewritten into a point cloud's local frame, plus the conversions
 *  needed to move distances and hit positions back out to world space. */
export interface LocalFrameRay {
  origin: Vec3;
  /** Unit-length in local space, so `queryRay`'s `t` stays a true distance. */
  direction: Vec3;
  /** World distance = local distance * this. 1 for an identity transform. */
  distanceScale: number;
  /** Map a local-space hit position back to world space. */
  toWorld(p: Vec3): Vec3;
}

/**
 * Uniform scale factor of a column-major 4x4's linear part.
 *
 * Exact for a similarity transform (every column has the same length);
 * for a non-uniform matrix it returns the mean, which keeps snap
 * tolerances in the right ballpark rather than exact. Returns 1 for a
 * degenerate (~zero) matrix so callers never divide by zero.
 */
export function matrixUniformScale(m: Float32Array): number {
  const cx = Math.hypot(m[0], m[1], m[2]);
  const cy = Math.hypot(m[4], m[5], m[6]);
  const cz = Math.hypot(m[8], m[9], m[10]);
  const mean = (cx + cy + cz) / 3;
  return mean > 1e-12 ? mean : 1;
}

/**
 * True when `m` is close enough to the identity that transforming through
 * it is pure overhead. The overwhelmingly common case is an unaligned
 * scan, and this keeps that path allocation-free.
 */
export function isIdentityMatrix(m: Float32Array): boolean {
  const EPS = 1e-6;
  for (let i = 0; i < 16; i++) {
    const expected = i % 5 === 0 ? 1 : 0;
    if (Math.abs(m[i] - expected) > EPS) return false;
  }
  return true;
}

/**
 * Rewrite a world-space ray into `model`'s local frame.
 *
 * Returns `null` when no transform is needed (absent, malformed, identity)
 * or when the matrix is singular — callers should then query with the
 * original world ray, which is the correct behaviour for an unaligned
 * cloud and a safe fallback for a degenerate matrix.
 */
export function toLocalFrameRay(
  origin: Vec3,
  direction: Vec3,
  model: Float32Array | undefined,
): LocalFrameRay | null {
  if (!isUsableModelMatrix(model) || isIdentityMatrix(model)) return null;

  const inv = MathUtils.invert({ m: model });
  if (!inv) return null;
  const i = inv.m;

  const ox = i[0] * origin.x + i[4] * origin.y + i[8] * origin.z + i[12];
  const oy = i[1] * origin.x + i[5] * origin.y + i[9] * origin.z + i[13];
  const oz = i[2] * origin.x + i[6] * origin.y + i[10] * origin.z + i[14];

  // Direction is a vector: no translation column.
  const dx = i[0] * direction.x + i[4] * direction.y + i[8] * direction.z;
  const dy = i[1] * direction.x + i[5] * direction.y + i[9] * direction.z;
  const dz = i[2] * direction.x + i[6] * direction.y + i[10] * direction.z;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-12)) return null;

  const m = model;
  return {
    origin: { x: ox, y: oy, z: oz },
    direction: { x: dx / len, y: dy / len, z: dz / len },
    distanceScale: matrixUniformScale(m),
    toWorld: (p: Vec3): Vec3 => ({
      x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
      y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
      z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    }),
  };
}
