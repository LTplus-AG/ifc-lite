/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BVH, type AABB, type MeshWithBounds } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';
import { sub, cross, dot } from '../math/vec3.js';

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

  constructor(positions: Float32Array, indices: Uint32Array, transform?: Mat4) {
    this.positions = positions;
    this.indices = indices;
    this.transform = transform;
    this.count = Math.floor(indices.length / 3);

    const items: MeshWithBounds[] = [];
    for (let t = 0; t < this.count; t += 1) {
      items.push({ bounds: this.triBounds(t), expressId: t });
    }
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

  /**
   * True when `p` is inside this closed mesh. Casts a fixed-direction ray and
   * counts forward crossings against every triangle (Möller–Trumbore,
   * double-sided so winding doesn't matter); an odd count means inside.
   *
   * Iterates all triangles in index order — deliberately NOT the BVH — so the
   * result is bit-identical to the Rust `contains_point`. Only invoked in the
   * rare enclosed-solid branch of the narrow phase, so the O(n) cost is fine.
   */
  containsPoint(p: Vec3): boolean {
    let crossings = 0;
    for (let t = 0; t < this.count; t += 1) {
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
