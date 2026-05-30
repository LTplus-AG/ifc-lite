/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BVH, type AABB, type MeshWithBounds } from '@ifc-lite/spatial';
import type { Mat4, Vec3 } from '../types.js';

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
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
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
}
