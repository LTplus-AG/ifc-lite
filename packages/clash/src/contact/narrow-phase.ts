/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildMeshBvh, queryMeshCross } from "./mesh-bvh.js";
import { triTriIntersect } from "./tri-tri.js";
import type { Triangle } from "./triangle.js";
import { triangleAt, triangleCount } from "./triangle.js";
import type { Mesh, Vec3 } from "./types.js";

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
  /** Plane-distance tolerance for coplanarity and Möller sign tests. */
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
  const planeEps = opts.planeEps ?? 1e-6;
  const leafSize = opts.leafSize ?? 8;

  if (triangleCount(a) === 0 || triangleCount(b) === 0) return [];

  const bvhA = buildMeshBvh(a, leafSize);
  const bvhB = buildMeshBvh(b, leafSize);
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
