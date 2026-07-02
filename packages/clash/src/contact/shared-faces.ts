/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared-face clustering.
 *
 * Inputs: TrianglePair[] emitted by narrowPhase() for a single pair of
 * elements. Output: one or more SharedFaceCluster objects, each representing
 * a distinct contact between the two elements, classified as
 * surface / line / point.
 *
 * Coplanar pairs cluster by plane key. For each cluster we Sutherland-Hodgman
 * every (A,B) triangle pair on the shared plane, sum polygon areas, build a
 * 3D boundary polygon as the convex hull of the union of clip vertices.
 *
 * Cross pairs cluster by intersection-line key (direction + point on line).
 * Length is the union length of the per-pair 3D segments projected onto
 * the line direction.
 *
 * Remaining incidental contacts fall into either classification by
 * magnitude against the thresholds.
 */

import type { TrianglePair } from "./narrow-phase.js";
import type { Plane } from "./plane.js";
import { liftTo3D, planeBasis, planeFromNormalPoint, planeKey, projectTo2D } from "./plane.js";
import type { Point2 } from "./polygon-clip.js";
import { convexHull2, polygonArea, polygonCentroid, sutherlandHodgman } from "./polygon-clip.js";
import { triangleNormalRaw } from "./triangle.js";
import type { Vec3 } from "./types.js";
import { cross3, dot3, length3, normalize3 } from "./vec3.js";

export interface SharedFaceCluster {
  readonly kind: "surface" | "line" | "point";
  /** Anchoring plane (for surface) or line (for line/point, where direction is the line dir). */
  readonly plane?: Plane;
  /** World-space centroid of the contact. */
  readonly centroid: Vec3;
  /** Outward normal (surface) or line direction (line/point). */
  readonly normal: Vec3;
  /** Shared-face area in m² (surface only — 0 otherwise). */
  readonly area_m2: number;
  /** Shared-line length in m (line only — 0 otherwise). */
  readonly length_m: number;
  /** Narrowest dimension of the contact patch in m. Distinguishes a broad
   *  face (layered wall) from a thin bearing strip / cap. Length for a line
   *  cluster is carried by `length_m`, so its `spanMin` is 0. */
  readonly spanMin: number;
  /** Widest dimension (diameter) of the contact patch in m. */
  readonly spanMax: number;
  /** Boundary polygon (3D) for surface contacts. Segment endpoints for line contacts. Empty for point. */
  readonly boundary: readonly Vec3[];
  /** Contributing triangle pairs. */
  readonly pairs: readonly TrianglePair[];
}

export interface SharedFaceOptions {
  /** Absolute tolerance for plane coincidence (unit: model-native length). Default 1e-3. */
  readonly planeDistSnap?: number;
  /** Angular snap for plane normal hashing (unitless, ~1 − cos). Default 1e-3. */
  readonly planeAngleSnap?: number;
  /** Area (m²) threshold: ≥ surface. Default 0.01. */
  readonly surfaceAreaM2?: number;
  /** Area (m²) below which a contact may still be line or point. Default 0.001. */
  readonly pointAreaM2?: number;
  /** Length (m) threshold: ≥ line. Default 0.05. */
  readonly lineLengthM?: number;
  /** Snap used when hashing intersection-line direction + base point. Default 1e-3. */
  readonly lineSnap?: number;
}

export function clusterSharedFaces(
  pairs: readonly TrianglePair[],
  opts: SharedFaceOptions = {},
): SharedFaceCluster[] {
  const planeDistSnap = opts.planeDistSnap ?? 1e-3;
  const planeAngleSnap = opts.planeAngleSnap ?? 1e-3;
  const lineSnap = opts.lineSnap ?? 1e-3;
  const surfaceAreaM2 = opts.surfaceAreaM2 ?? 0.01;
  const pointAreaM2 = opts.pointAreaM2 ?? 0.001;
  const lineLengthM = opts.lineLengthM ?? 0.05;

  if (pairs.length === 0) return [];

  // 1. Split into coplanar clusters and cross clusters.
  const coplanarBuckets = new Map<string, { plane: Plane; pairs: TrianglePair[] }>();
  const crossBuckets = new Map<string, { dir: Vec3; point: Vec3; pairs: TrianglePair[] }>();

  for (const p of pairs) {
    if (p.kind === "coplanar") {
      const n = triangleNormalRaw(p.a);
      const ln = length3(n);
      if (ln === 0) continue;
      const plane = planeFromNormalPoint(n, p.a.v0);
      const key = planeKey(plane, planeAngleSnap, planeDistSnap);
      const entry = coplanarBuckets.get(key) ?? { plane, pairs: [] };
      entry.pairs.push(p);
      coplanarBuckets.set(key, entry);
    } else if (p.kind === "cross") {
      const seg: Vec3 = [p.p1[0] - p.p0[0], p.p1[1] - p.p0[1], p.p1[2] - p.p0[2]];
      const len = length3(seg);
      if (len < 1e-12) continue;
      const dir = normalize3(seg);
      // Canonicalise direction so parallel + anti-parallel hash identically.
      const canon = canonicaliseDir(dir);
      const base = closestPointOnLineFromOrigin(p.p0, canon);
      const key = `${quant(canon[0], lineSnap)}|${quant(canon[1], lineSnap)}|${quant(canon[2], lineSnap)}|${quant(base[0], lineSnap)}|${quant(base[1], lineSnap)}|${quant(base[2], lineSnap)}`;
      const entry = crossBuckets.get(key) ?? { dir: canon, point: base, pairs: [] };
      entry.pairs.push(p);
      crossBuckets.set(key, entry);
    }
  }

  const out: SharedFaceCluster[] = [];
  for (const { plane, pairs: bucketPairs } of coplanarBuckets.values()) {
    out.push(
      classify(buildSurfaceCluster(plane, bucketPairs), surfaceAreaM2, pointAreaM2, lineLengthM),
    );
  }
  for (const { dir, pairs: bucketPairs } of crossBuckets.values()) {
    out.push(classify(buildLineCluster(dir, bucketPairs), surfaceAreaM2, pointAreaM2, lineLengthM));
  }
  return out;
}

// -------- surface / coplanar clusters --------

function buildSurfaceCluster(
  plane: Plane,
  bucketPairs: TrianglePair[],
): Omit<SharedFaceCluster, "kind"> {
  const basis = planeBasis(plane);
  let totalArea = 0;
  const boundaryPts: Point2[] = [];

  for (const p of bucketPairs) {
    const pa = [projectTo2D(basis, p.a.v0), projectTo2D(basis, p.a.v1), projectTo2D(basis, p.a.v2)];
    const pb = [projectTo2D(basis, p.b.v0), projectTo2D(basis, p.b.v1), projectTo2D(basis, p.b.v2)];
    // Clip A against B; union of these clip polygons approximates the
    // true shared face. For typical IFC meshes (tiled, non-overlapping)
    // summed clip area ≤ true contact area ≤ the total area of A-triangles
    // whose pair is in the bucket. We take the clipped sum.
    const clipped = sutherlandHodgman(pa, pb);
    if (clipped.length >= 3) {
      totalArea += polygonArea(clipped);
      boundaryPts.push(...clipped);
    }
  }

  const boundary2d = boundaryPts.length >= 3 ? convexHull2(boundaryPts) : boundaryPts;
  const centroid2d: Point2 =
    boundary2d.length >= 3
      ? polygonCentroid(boundary2d)
      : boundary2d.length === 0
        ? [0, 0]
        : averagePoint2(boundary2d);
  const centroid = liftTo3D(basis, centroid2d);
  const boundary = boundary2d.map((p) => liftTo3D(basis, p));
  const spans = polygonSpans(boundary2d);

  return {
    plane,
    centroid,
    normal: plane.normal,
    area_m2: totalArea,
    length_m: 0,
    spanMin: spans.min,
    spanMax: spans.max,
    boundary,
    pairs: bucketPairs,
  };
}

/**
 * Narrowest and widest dimensions of a convex 2D polygon (metres). `max` is
 * the diameter (largest vertex-pair distance); `min` is the rotating-calipers
 * width — the smallest gap between two parallel supporting lines. Degenerate
 * (< 3 pts) polygons have width 0.
 */
function polygonSpans(pts: readonly Point2[]): { min: number; max: number } {
  const n = pts.length;
  if (n === 0) return { min: 0, max: 0 };
  let max = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pts[i] as Point2;
      const b = pts[j] as Point2;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > max) max = d;
    }
  }
  if (n < 3) return { min: 0, max };
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const a = pts[i] as Point2;
    const b = pts[(i + 1) % n] as Point2;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-12) continue;
    const nx = -ey / elen;
    const ny = ex / elen;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      const d = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const width = hi - lo;
    if (width < min) min = width;
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

// -------- line / cross clusters --------

function buildLineCluster(dir: Vec3, bucketPairs: TrianglePair[]): Omit<SharedFaceCluster, "kind"> {
  // Project every segment onto the line direction to get 1D intervals,
  // union them, sum to get length.
  const intervals: Array<[number, number]> = [];
  let refPoint: Vec3 | null = null;

  for (const p of bucketPairs) {
    if (p.kind !== "cross") continue;
    if (!refPoint) refPoint = p.p0;
    const t0 = projectOnto(p.p0, refPoint, dir);
    const t1 = projectOnto(p.p1, refPoint, dir);
    intervals.push([Math.min(t0, t1), Math.max(t0, t1)]);
  }
  if (!refPoint || intervals.length === 0) {
    return {
      centroid: [0, 0, 0],
      normal: dir,
      area_m2: 0,
      length_m: 0,
      spanMin: 0,
      spanMax: 0,
      boundary: [],
      pairs: bucketPairs,
    };
  }

  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    if (merged.length === 0) {
      merged.push([iv[0], iv[1]]);
      continue;
    }
    const last = merged[merged.length - 1] as [number, number];
    if (iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const length = merged.reduce((s, iv) => s + (iv[1] - iv[0]), 0);

  // Pick the union's overall min/max as the line's centroid basis.
  const tMin = (merged[0] as [number, number])[0];
  const tMax = (merged[merged.length - 1] as [number, number])[1];
  const centroidT = (tMin + tMax) / 2;
  const centroid: Vec3 = [
    refPoint[0] + dir[0] * centroidT,
    refPoint[1] + dir[1] * centroidT,
    refPoint[2] + dir[2] * centroidT,
  ];
  const boundary: Vec3[] = [
    [refPoint[0] + dir[0] * tMin, refPoint[1] + dir[1] * tMin, refPoint[2] + dir[2] * tMin],
    [refPoint[0] + dir[0] * tMax, refPoint[1] + dir[1] * tMax, refPoint[2] + dir[2] * tMax],
  ];

  return {
    centroid,
    normal: dir,
    area_m2: 0,
    length_m: length,
    spanMin: 0,
    spanMax: length,
    boundary,
    pairs: bucketPairs,
  };
}

// -------- helpers --------

function classify(
  base: Omit<SharedFaceCluster, "kind">,
  surfaceAreaM2: number,
  pointAreaM2: number,
  lineLengthM: number,
): SharedFaceCluster {
  if (base.area_m2 >= surfaceAreaM2) return { ...base, kind: "surface" };
  if (base.length_m >= lineLengthM) return { ...base, kind: "line" };
  if (base.area_m2 >= pointAreaM2) return { ...base, kind: "line" };
  return { ...base, kind: "point" };
}

function canonicaliseDir(v: Vec3): Vec3 {
  // Flip so the first significant component is positive.
  if (Math.abs(v[0]) > 1e-9) return v[0] > 0 ? v : [-v[0], -v[1], -v[2]];
  if (Math.abs(v[1]) > 1e-9) return v[1] > 0 ? v : [-v[0], -v[1], -v[2]];
  return v[2] > 0 ? v : [-v[0], -v[1], -v[2]];
}

function closestPointOnLineFromOrigin(point: Vec3, dir: Vec3): Vec3 {
  const t = dot3(point, dir);
  return [point[0] - dir[0] * t, point[1] - dir[1] * t, point[2] - dir[2] * t];
}

function projectOnto(point: Vec3, refPoint: Vec3, dir: Vec3): number {
  return (
    (point[0] - refPoint[0]) * dir[0] +
    (point[1] - refPoint[1]) * dir[1] +
    (point[2] - refPoint[2]) * dir[2]
  );
}

function quant(x: number, snap: number): number {
  return Math.round(x / snap);
}

function averagePoint2(pts: readonly Point2[]): Point2 {
  if (pts.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

// keep symbol imports that downstream modules may re-export
void cross3;
