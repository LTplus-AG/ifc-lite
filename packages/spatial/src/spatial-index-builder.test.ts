/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { buildSpatialIndex, buildSpatialIndexAsync } from './spatial-index-builder.js';
import type { AABB } from './aabb.js';

function box(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): AABB {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Minimal MeshData: an axis-aligned cube of `size` around `center`, local frame. */
function mesh(
  expressId: number,
  center: [number, number, number],
  size = 1,
  origin?: [number, number, number],
): MeshData {
  const h = size / 2;
  const [cx, cy, cz] = center;
  const positions = new Float32Array([
    cx - h, cy - h, cz - h,
    cx + h, cy - h, cz - h,
    cx + h, cy + h, cz + h,
    cx - h, cy + h, cz + h,
  ]);
  const m: MeshData = {
    expressId,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
  };
  if (origin) m.origin = origin;
  return m;
}

describe('buildSpatialIndex', () => {
  it('indexes meshes by their world-space bounds', () => {
    const bvh = buildSpatialIndex([mesh(1, [0, 0, 0]), mesh(2, [10, 0, 0])]);
    expect(bvh.queryAABB(box(-1, -1, -1, 1, 1, 1))).toEqual([1]);
    expect(bvh.queryAABB(box(9, -1, -1, 11, 1, 1))).toEqual([2]);
  });

  it('lifts local positions by the per-mesh origin into world space', () => {
    // Positions are LOCAL (centred on 0); the element actually sits at
    // (100, 0, 0). Without the origin lift the index answers queries about the
    // model origin instead of where the element is — every clash broad-phase
    // candidate and every viewer pick on an origin-offset model is then wrong.
    const bvh = buildSpatialIndex([mesh(42, [0, 0, 0], 2, [100, 0, 0])]);
    expect(bvh.queryAABB(box(99, -1, -1, 101, 1, 1))).toEqual([42]);
    expect(bvh.queryAABB(box(-1, -1, -1, 1, 1, 1))).toEqual([]);
  });

  it('applies the origin lift per axis, not just on x', () => {
    const bvh = buildSpatialIndex([mesh(7, [0, 0, 0], 2, [0, -50, 25])]);
    expect(bvh.queryAABB(box(-1, -51, 24, 1, -49, 26))).toEqual([7]);
    // A query at the mirrored offsets must NOT hit: proves y and z are lifted
    // with the right sign, not merely by the same magnitude.
    expect(bvh.queryAABB(box(-1, 49, -26, 1, 51, -24))).toEqual([]);
  });

  it('treats an absent origin as no offset', () => {
    const bvh = buildSpatialIndex([mesh(3, [5, 5, 5], 2)]);
    expect(bvh.queryAABB(box(4, 4, 4, 6, 6, 6))).toEqual([3]);
  });

  it('gives an empty mesh a degenerate box at the model origin, not Infinity', () => {
    const empty: MeshData = {
      expressId: 9,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      color: [1, 1, 1, 1],
    };
    const bvh = buildSpatialIndex([empty]);
    // A degenerate [0,0,0] box: found at the origin, and — crucially — NOT
    // found everywhere, which is what an un-initialised ±Infinity box does.
    expect(bvh.queryAABB(box(0, 0, 0, 0, 0, 0))).toEqual([9]);
    expect(bvh.queryAABB(box(1000, 1000, 1000, 1001, 1001, 1001))).toEqual([]);
  });

  it('gives an empty mesh a degenerate box at the mesh origin when one is set', () => {
    // Same shape as above, but with a non-zero per-mesh origin. The empty-mesh
    // early return must apply the same origin lift as the populated-mesh path,
    // not silently place the mesh at world [0,0,0].
    const empty: MeshData = {
      expressId: 9,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      color: [1, 1, 1, 1],
      origin: [500, 500, 500],
    };
    const bvh = buildSpatialIndex([empty]);
    expect(bvh.queryAABB(box(500, 500, 500, 500, 500, 500))).toEqual([9]);
    expect(bvh.queryAABB(box(0, 0, 0, 0, 0, 0))).toEqual([]);
  });

  it('returns a queryable empty index for no meshes', () => {
    expect(buildSpatialIndex([]).queryAABB(box(-1e9, -1e9, -1e9, 1e9, 1e9, 1e9))).toEqual([]);
  });
});

describe('buildSpatialIndexAsync', () => {
  it('produces the same index as the synchronous builder', async () => {
    const meshes = Array.from({ length: 40 }, (_, i) => mesh(i + 1, [i * 5, 0, 0], 1));
    const sync = buildSpatialIndex(meshes);
    const async_ = await buildSpatialIndexAsync(meshes);
    const q = box(-1, -1, -1, 21, 1, 1);
    expect(async_.queryAABB(q).sort((a, b) => a - b)).toEqual(sync.queryAABB(q).sort((a, b) => a - b));
  });

  it('indexes EVERY mesh when the workload spans several time slices', async () => {
    // budgetMs = 0 forces a yield at every 500-mesh checkpoint, exercising the
    // chunk-resume path. A resume bug (restarting or skipping a chunk) shows up
    // as a missing or duplicated expressId.
    const meshes = Array.from({ length: 1200 }, (_, i) => mesh(i + 1, [i, 0, 0], 0.5));
    const bvh = await buildSpatialIndexAsync(meshes, 0);
    const all = bvh.queryAABB(box(-10, -10, -10, 2000, 10, 10));
    expect(all).toHaveLength(1200);
    expect(new Set(all).size).toBe(1200);
    // Spot-check the boundaries of the 500-mesh chunks.
    expect(bvh.queryAABB(box(499.6, -1, -1, 500.4, 1, 1))).toEqual([501]);
    expect(bvh.queryAABB(box(999.6, -1, -1, 1000.4, 1, 1))).toEqual([1001]);
  });

  it('carries the origin lift through the async path too', async () => {
    const bvh = await buildSpatialIndexAsync([mesh(42, [0, 0, 0], 2, [100, 0, 0])], 0);
    expect(bvh.queryAABB(box(99, -1, -1, 101, 1, 1))).toEqual([42]);
    expect(bvh.queryAABB(box(-1, -1, -1, 1, 1, 1))).toEqual([]);
  });

  it('returns a queryable empty index for no meshes', async () => {
    const bvh = await buildSpatialIndexAsync([]);
    expect(bvh.queryAABB(box(-1e9, -1e9, -1e9, 1e9, 1e9, 1e9))).toEqual([]);
  });
});
