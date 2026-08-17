/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildMeshBvh, queryMeshCross } from "./mesh-bvh.js";
import { triTriIntersect, type ProjectedPlaneEps } from "./tri-tri.js";
import type { Triangle } from "./triangle.js";
import { triangleAt, triangleCount } from "./triangle.js";
import type { AABB, Mesh, Vec3 } from "./types.js";

/**
 * f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
 * value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
 * larger magnitudes the ULP only grows. Same `2^-22` term (and reasoning) as
 * `near_band_from_extent` in `rust/geometry/src/kernel/near_band.rs` and
 * `precisionFloor` in `engine-ts/narrow.ts` — kept local rather than shared
 * because plane-distance tolerance and penetration-depth tolerance are
 * different jobs, even though both derive from the same f32 ingestion floor.
 */
const F32_ULP_SCALE = 1 / 4_194_304; // 2^-22

/**
 * Default plane-distance tolerance for {@link triTriIntersect}, scaled to
 * this pair's own coordinate magnitude rather than a fixed constant.
 *
 * Geometry is ingested from f32 buffers throughout this codebase, so a fixed
 * `1e-6` is only valid near the origin: the true discrete f32 ULP exceeds
 * `1e-6` above 16 m and reaches ~4.9e-4 at 5 km. Two triangles authored to be
 * flush at ordinary building coordinates round to adjacent — not
 * bit-identical — f32 values, and a too-tight fixed epsilon then reads that
 * rounding noise as a genuine non-coplanar separation, discarding the
 * shared-face contact entirely rather than reporting it as
 * `touch`/`coplanar`.
 *
 * Crucially, the extent must be taken PER AXIS and projected onto each
 * plane's own normal (`epsForPlane` in `./tri-tri.js`), not collapsed to a
 * single max over all three axes of both AABBs. The tolerance is compared
 * against a signed distance measured along ONE plane normal, and each
 * coordinate's rounding noise enters that distance weighted by its axis's
 * normal component; an axis orthogonal to the normal contributes nothing.
 * A max-over-axes scalar instead scales the tolerance to the meshes'
 * DISTANCE FROM THE WORLD ORIGIN along whichever axis happens to be
 * largest, even when that axis is irrelevant to the plane being tested:
 * two horizontal faces (normal Z) with a genuine 2.0 mm Z-clearance
 * authored 10 km along X got planeEps = 10000 * 2^-22 = 2.384 mm, inflated
 * entirely by the irrelevant X axis, and were fabricated as coplanar
 * contact (above ~8.4 km extent every near-parallel candidate pair reads
 * as coplanar). Same reasoning as the LOCAL-vs-world tolerance sizing in
 * `section-cutter.ts` (#2622): size the tolerance off the quantity the
 * noise actually scales with, never off an unrelated world magnitude.
 *
 * The projected result is floored at the old fixed `1e-6`
 * (`ProjectedPlaneEps.floor`): scaling must only ever *widen* the tolerance
 * relative to the constant it replaces, never narrow it: a bare
 * `extent * F32_ULP_SCALE` is far tighter than `1e-6` for any extent under
 * ~4.19 m, which reintroduces the exact dropped-shared-face bug this
 * function exists to fix.
 */
function scaledPlaneEps(aabbA: AABB, aabbB: AABB): ProjectedPlaneEps {
  const axisNoise: [number, number, number] = [0, 0, 0];
  for (const aabb of [aabbA, aabbB]) {
    for (const v of [aabb.min, aabb.max]) {
      for (let i = 0; i < 3; i++) {
        const a = Math.abs(v[i] as number) * F32_ULP_SCALE;
        if (a > (axisNoise[i] as number)) axisNoise[i] = a;
      }
    }
  }
  return { axisNoise, floor: 1e-6 };
}

export type TrianglePair =
  | {
      readonly triA: number;
      readonly triB: number;
      readonly a: Triangle;
      readonly b: Triangle;
      readonly kind: "coplanar";
    }
  | {
      readonly triA: number;
      readonly triB: number;
      readonly a: Triangle;
      readonly b: Triangle;
      readonly kind: "cross";
      /** 3D endpoints of the intersection segment on the common line. */
      readonly p0: Vec3;
      readonly p1: Vec3;
    };

export interface NarrowPhaseOptions {
  /** AABB inflation (world units). Default 0.002 (2 mm). */
  readonly epsilon?: number;
  /**
   * Plane-distance tolerance for coplanarity and Möller sign tests. Defaults
   * to {@link scaledPlaneEps}'s per-axis f32-ULP noise, projected onto each
   * tested plane's own normal, not a fixed constant nor a single max over
   * all axes; see that function's doc.
   */
  readonly planeEps?: number;
  /** BVH leaf size for per-mesh triangle BVHs. Default 8. */
  readonly leafSize?: number;
}

/**
 * For two meshes A and B, return every triangle pair whose triangles
 * either strictly cross or are coplanar (and whose AABBs are within
 * `epsilon` of each other).
 *
 * Coplanar pairs are emitted without further 2D-overlap testing —
 * shared-face clustering (downstream) does that more robustly across
 * a whole cluster of coplanar hits.
 */
export function narrowPhase(a: Mesh, b: Mesh, opts: NarrowPhaseOptions = {}): TrianglePair[] {
  const epsilon = opts.epsilon ?? 0.002;
  const leafSize = opts.leafSize ?? 8;

  if (triangleCount(a) === 0 || triangleCount(b) === 0) return [];

  const bvhA = buildMeshBvh(a, leafSize);
  const bvhB = buildMeshBvh(b, leafSize);
  // Bvh.build only returns a null root for an empty item list; both meshes
  // were checked non-empty above, so both roots exist.
  const rootA = bvhA.bvh.root;
  const rootB = bvhB.bvh.root;
  const planeEps =
    opts.planeEps ?? (rootA && rootB ? scaledPlaneEps(rootA.bounds, rootB.bounds) : 1e-6);
  const candidates = queryMeshCross(bvhA, bvhB, epsilon);

  const out: TrianglePair[] = [];
  for (const [iA, iB] of candidates) {
    const triA = triangleAt(a, iA);
    const triB = triangleAt(b, iB);
    const res = triTriIntersect(triA, triB, planeEps);
    if (res.kind === "none") continue;
    if (res.kind === "coplanar") {
      out.push({ triA: iA, triB: iB, a: triA, b: triB, kind: "coplanar" });
    } else {
      out.push({
        triA: iA,
        triB: iB,
        a: triA,
        b: triB,
        kind: "cross",
        p0: res.p0,
        p1: res.p1,
      });
    }
  }

  return out;
}
