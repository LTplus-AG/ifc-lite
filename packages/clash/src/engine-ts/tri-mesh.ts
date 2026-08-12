/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BVH, type AABB, type MeshWithBounds } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';
import { sub, cross, dot, distSq } from '../math/vec3.js';
import { closestPtPointTriangle } from '../math/triangle-distance.js';
import { detectObb, type Obb } from './obb.js';

/**
 * Fixed ray direction for point-in-solid tests: `normalize([1, √3, √5])`.
 * Deliberately NON-axis-aligned so the ray never grazes the edges/vertices of
 * axis-aligned boxes (which would double-count crossings). Written as exact
 * IEEE-754 literals (not computed via `normalize()`) so the Rust kernel uses
 * byte-identical components — `|RAY_DIR| === 1` exactly.
 */
const RAY_DIR: Vec3 = [0.3333333333333333, 0.5773502691896257, 0.7453559924999299];
/** Parallel-reject + forward-crossing threshold. Same literal in the Rust kernel. */
const RAY_EPS = 1e-9;

/** The axis-aligned cube of half-size `h` centred on `p`. */
function cubeAround(p: Vec3, h: number): AABB {
  return {
    min: [p[0] - h, p[1] - h, p[2] - h],
    max: [p[0] + h, p[1] + h, p[2] + h],
  };
}

/**
 * A triangle mesh with a per-triangle BVH for narrow-phase queries. Built once
 * per element per run and cached by the engine, so each element's triangle
 * index is paid for at most once even when it appears in several rules.
 */
export class TriMesh {
  readonly count: number;
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly transform?: Mat4;
  private readonly bvh: BVH;
  /**
   * Starting half-size for the expanding-cube probe in `distanceToSurface`: a
   * power-of-two fraction of the mesh's longest axis, scaled down by the cube
   * root of the triangle count so it lands near the average triangle size.
   * Derived with exact power-of-two arithmetic (no `pow`/`cbrt`, whose last bit
   * is not guaranteed to agree between JS and Rust) — the Rust
   * `TriMesh::probe_seed` computes the identical value.
   */
  private readonly probeSeed: number;
  /** Memoized `detectObb(this)` result; `undefined` until first requested.
   * Computed at most once per element per run, same lifetime as the mesh. */
  private obbCache: Obb | null | undefined;

  constructor(positions: Float32Array, indices: Uint32Array, transform?: Mat4) {
    this.positions = positions;
    this.indices = indices;
    this.transform = transform;
    this.count = Math.floor(indices.length / 3);

    const items: MeshWithBounds[] = [];
    let extent = 0;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < this.count; t += 1) {
      const bounds = this.triBounds(t);
      items.push({ bounds, expressId: t });
      for (let a = 0; a < 3; a += 1) {
        if (bounds.min[a] < lo[a]) lo[a] = bounds.min[a];
        if (bounds.max[a] > hi[a]) hi[a] = bounds.max[a];
      }
    }
    for (let a = 0; a < 3; a += 1) {
      const e = hi[a] - lo[a];
      if (e > extent) extent = e;
    }
    // Halve the extent once per factor of 8 in the triangle count (≈ one
    // subdivision step per axis). Both the loop and the division are exact.
    let divisor = 1;
    let cap = 8;
    while (cap <= this.count && divisor < 1048576) {
      divisor *= 2;
      cap *= 8;
    }
    const seed = extent / divisor;
    this.probeSeed = seed > 0 && seed < Infinity ? seed : 1;
    this.bvh = BVH.build(items);
  }

  /** World-space vertex `i` (applies the element transform if present). */
  vertex(i: number): Vec3 {
    const o = i * 3;
    const x = this.positions[o];
    const y = this.positions[o + 1];
    const z = this.positions[o + 2];
    const m = this.transform;
    if (!m) return [x, y, z];
    // Round the transformed coords to f32. The WASM kernel bakes the transform in
    // JS f64 then packs the arena as a Float32Array (Rust widens f32→f64), so its
    // world coords are f32-quantized. Match that here, or the two kernels would
    // feed slightly different world-space vertices into the otherwise byte-
    // identical narrow phase and diverge at a tolerance boundary. The no-transform
    // path is already f32 (positions is a Float32Array), so this only bites the
    // transformed path. See differential.test.ts "non-identity transform".
    return [
      Math.fround(m[0] * x + m[4] * y + m[8] * z + m[12]),
      Math.fround(m[1] * x + m[5] * y + m[9] * z + m[13]),
      Math.fround(m[2] * x + m[6] * y + m[10] * z + m[14]),
    ];
  }

  /** The three world-space vertices of triangle `t`. */
  tri(t: number): [Vec3, Vec3, Vec3] {
    const o = t * 3;
    return [
      this.vertex(this.indices[o]),
      this.vertex(this.indices[o + 1]),
      this.vertex(this.indices[o + 2]),
    ];
  }

  triBounds(t: number): AABB {
    const [a, b, c] = this.tri(t);
    return {
      min: [
        Math.min(a[0], b[0], c[0]),
        Math.min(a[1], b[1], c[1]),
        Math.min(a[2], b[2], c[2]),
      ],
      max: [
        Math.max(a[0], b[0], c[0]),
        Math.max(a[1], b[1], c[1]),
        Math.max(a[2], b[2], c[2]),
      ],
    };
  }

  /** Triangle indices whose bounds intersect `bounds`. */
  queryTris(bounds: AABB): number[] {
    if (this.count === 0) return [];
    return this.bvh.queryAABB(bounds);
  }

  /** Memoized `Obb` for this mesh, or `null` when the mesh is not (within
   * tolerance) a rectangular box. See `obb.ts` for the detection rule. */
  getObb(): Obb | null {
    if (this.obbCache === undefined) this.obbCache = detectObb(this);
    return this.obbCache;
  }

  /**
   * Mean of every vertex (world-space, transform applied), summed in index
   * order. A rigid-invariant interior probe for the volumetric-overlap check in
   * the narrow phase: for a convex solid it is the centroid, and the midpoint of
   * two solids' vertex centroids lands in their shared volume for a genuine
   * overlap (but on/outside the interface for a bare face touch). Iterated in
   * index order and summed in `f64` so it is bit-identical to the Rust
   * `vertex_centroid`. Only called in the rare coplanar-overlap branch.
   */
  vertexCentroid(): Vec3 {
    const n = Math.floor(this.positions.length / 3);
    if (n === 0) return [0, 0, 0];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < n; i += 1) {
      const [x, y, z] = this.vertex(i);
      sx += x;
      sy += y;
      sz += z;
    }
    return [sx / n, sy / n, sz / n];
  }

  /** Minimum point-to-triangle distance over `tris`, as a squared distance. */
  private minDistSqOver(p: Vec3, tris: readonly number[]): number {
    let best = Infinity;
    for (const t of tris) {
      const [a, b, c] = this.tri(t);
      const q = closestPtPointTriangle(p, a, b, c);
      const d2 = distSq(p, q);
      if (d2 < best) best = d2;
    }
    return best;
  }

  /** Exhaustive fallback for `distanceToSurface`: every triangle, index order. */
  private distanceToSurfaceScan(p: Vec3): number {
    let best = Infinity;
    for (let t = 0; t < this.count; t += 1) {
      const [a, b, c] = this.tri(t);
      const q = closestPtPointTriangle(p, a, b, c);
      const d2 = distSq(p, q);
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  /**
   * Exact distance from `p` to this mesh's surface: the minimum point-to-
   * triangle distance over the whole mesh.
   *
   * Not on the narrow-phase hot path as of PR #2536 (its former caller,
   * `maxPenetrationInto`, was removed — see `obb.ts`): a nearest-crossing-
   * VERTEX distance-to-surface probe is a sampling artifact that converges to
   * 0 under retessellation rather than to the true penetration depth. Kept as
   * a genuinely exact, independently tested primitive (see the shared probe
   * fixture in `tri-mesh.test.ts` / `kernel_tests.rs`) for future callers that
   * need it — e.g. clearance-to-nearest-surface — not as dead weight. Driven
   * by the triangle BVH rather than a linear scan so it stays cheap when it IS
   * called. The BVH is used through a plain `queryAABB`, so the value is still
   * the exact global minimum:
   *
   * 1. Query the cube of half-size `h` centred on `p`. Every triangle within
   *    distance `h` of `p` has its closest point inside that cube, hence its
   *    AABB intersects the cube, hence it is in the candidate set.
   * 2. If the candidate minimum `d` satisfies `d <= h`, the true minimum is
   *    `<= h` too, so its triangle was a candidate and `d` IS the true minimum.
   * 3. Otherwise `d` is still an upper bound on the true minimum, so one more
   *    query at half-size `d` provably captures the closest triangle.
   *
   * The reported value is therefore the same minimum the linear scan returns —
   * `min` selects an element, it does not accumulate, so visiting a superset of
   * the argmin in a different order returns the identical `f64`. The Rust
   * `distance_to_surface` runs the identical sequence of queries on the identical
   * BVH, so the two kernels stay bit-identical to each other (see the shared
   * probe fixture in `tri-mesh.test.ts` / `kernel_tests.rs`).
   *
   * The `wider.length === 0` arm below is unreachable, not a tested fallback:
   * `cubeAround(p, d)` with `d > h` strictly contains `cubeAround(p, h)`, whose
   * query was already non-empty, so every triangle that made `hits` non-empty
   * also intersects the wider cube — `wider` cannot come back empty. It is kept
   * only as defence-in-depth against a future `queryTris` regression, not as a
   * code path with coverage; do not read it as a tested safety net.
   */
  distanceToSurface(p: Vec3): number {
    if (this.count === 0) return Infinity;
    let h = this.probeSeed;
    // 64 doublings from a positive seed overflow to Infinity, whose cube
    // intersects every finite box — so the loop only runs out on NaN geometry,
    // which falls through to the exhaustive scan rather than spinning.
    for (let step = 0; step < 64; step += 1) {
      const hits = this.queryTris(cubeAround(p, h));
      if (hits.length > 0) {
        const d = Math.sqrt(this.minDistSqOver(p, hits));
        if (d <= h) return d;
        const wider = this.queryTris(cubeAround(p, d));
        if (wider.length > 0) return Math.sqrt(this.minDistSqOver(p, wider));
        return this.distanceToSurfaceScan(p);
      }
      h *= 2;
    }
    return this.distanceToSurfaceScan(p);
  }

  /**
   * True when `p` is inside this closed mesh. Casts a fixed-direction ray and
   * counts forward crossings (Möller–Trumbore, double-sided so winding doesn't
   * matter); an odd count means inside.
   *
   * Only the triangles the BVH reports along the ray are tested. A triangle the
   * ray hits at `tHit > RAY_EPS > 0` is hit inside its own AABB, so the slab
   * test admits it — the candidate set is a superset of the triangles a linear
   * scan would count, and the crossing count is an integer sum, so the parity
   * (and hence the verdict) is unchanged by the visit order. `RAY_DIR` is a
   * unit vector exactly, so `BVH.raycast`'s normalisation is the identity and
   * the slab test sees exactly `RAY_DIR`; the Rust `Bvh::raycast` mirrors this
   * traversal operation for operation, keeping the two kernels bit-identical.
   */
  containsPoint(p: Vec3): boolean {
    let crossings = 0;
    for (const t of this.bvh.raycast(p, RAY_DIR)) {
      const [v0, v1, v2] = this.tri(t);
      const e1 = sub(v1, v0);
      const e2 = sub(v2, v0);
      const pv = cross(RAY_DIR, e2);
      const det = dot(e1, pv);
      if (det > -RAY_EPS && det < RAY_EPS) continue; // ray parallel to triangle
      const inv = 1 / det;
      const tv = sub(p, v0);
      const u = dot(tv, pv) * inv;
      if (u < 0 || u > 1) continue;
      const qv = cross(tv, e1);
      const v = dot(RAY_DIR, qv) * inv;
      if (v < 0 || u + v > 1) continue;
      const tHit = dot(e2, qv) * inv;
      if (tHit > RAY_EPS) crossings += 1; // strictly forward
    }
    return (crossings & 1) === 1;
  }
}
