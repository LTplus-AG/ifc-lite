/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BVH, type MeshWithBounds } from './bvh.js';
import type { AABB } from './aabb.js';
import { FrustumUtils, type Frustum } from './frustum.js';

function box(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): AABB {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Unit cube centred on `c`, tagged with `expressId`. */
function cube(expressId: number, c: [number, number, number], half = 0.5): MeshWithBounds {
  return {
    expressId,
    bounds: box(c[0] - half, c[1] - half, c[2] - half, c[0] + half, c[1] + half, c[2] + half),
  };
}

/** A row of `n` unit cubes marching along +x, one per integer step. */
function row(n: number, axis: 0 | 1 | 2 = 0): MeshWithBounds[] {
  return Array.from({ length: n }, (_, i) => {
    const c: [number, number, number] = [0, 0, 0];
    c[axis] = i * 10;
    return cube(100 + i, c);
  });
}

/**
 * Rotation matrix about `axis` (normalized here) by `angle`, Rodrigues form,
 * as `R[row][col]`. Used to build a view-projection whose upper 3x3 has no
 * zero entry.
 */
function rotationAboutAxis(axis: [number, number, number], angle: number): number[][] {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

describe('BVH.build', () => {
  it('returns an empty index for no meshes without throwing', () => {
    const bvh = BVH.build([]);
    expect(bvh.queryAABB(box(-1e6, -1e6, -1e6, 1e6, 1e6, 1e6))).toEqual([]);
    expect(bvh.raycast([0, 0, 0], [1, 0, 0])).toEqual([]);
    expect(bvh.queryFrustum({ planes: [] })).toEqual([]);
  });

  it('indexes a single mesh (the leaf-only path)', () => {
    const bvh = BVH.build([cube(7, [0, 0, 0])]);
    expect(bvh.queryAABB(box(-1, -1, -1, 1, 1, 1))).toEqual([7]);
    expect(bvh.queryAABB(box(50, 50, 50, 51, 51, 51))).toEqual([]);
  });
});

describe('BVH.queryAABB', () => {
  it('returns only the meshes actually overlapping the query box', () => {
    // 20 cubes spread along x at 0,10,20,... — deep enough to force several
    // levels of internal nodes, so the recursion (not just the leaf scan) runs.
    const bvh = BVH.build(row(20));
    // Covers the cubes centred at 30 and 40 only.
    const hits = bvh.queryAABB(box(29, -1, -1, 41, 1, 1)).sort((a, b) => a - b);
    expect(hits).toEqual([103, 104]);
  });

  it('is inclusive at an exact face touch', () => {
    const bvh = BVH.build([cube(1, [0, 0, 0])]); // spans -0.5..0.5
    expect(bvh.queryAABB(box(0.5, 0, 0, 1, 0, 0))).toEqual([1]);
    expect(bvh.queryAABB(box(0.5001, 0, 0, 1, 0, 0))).toEqual([]);
  });

  it('finds every mesh when the query box covers the whole scene', () => {
    const meshes = row(20);
    const bvh = BVH.build(meshes);
    const hits = bvh.queryAABB(box(-100, -100, -100, 1000, 100, 100)).sort((a, b) => a - b);
    expect(hits).toEqual(meshes.map((m) => m.expressId).sort((a, b) => a - b));
  });

  it('does not miss meshes when the extent is longest on y or z', () => {
    // A scene laid out on x only never queries against a y- or z-dominant
    // hierarchy. Note what this does NOT pin: the split-axis choice itself is
    // a performance decision, invisible in the results (forcing `axis = 0` for
    // every node leaves the whole suite green — measured), so the value here
    // is the per-axis query geometry, and each iteration does discriminate on
    // its own axis (widening only the y slab fails the axis-1 iteration,
    // widening only z fails the axis-2 one).
    for (const axis of [1, 2] as const) {
      const meshes = row(9, axis);
      const bvh = BVH.build(meshes);
      const q: AABB = box(-1, -1, -1, 1, 1, 1);
      q.min[axis] = 29;
      q.max[axis] = 41;
      expect(bvh.queryAABB(q).sort((a, b) => a - b)).toEqual([103, 104]);
    }
  });

  it('handles a scene entirely in negative space', () => {
    const meshes = [cube(1, [-100, -100, -100]), cube(2, [-90, -100, -100]), cube(3, [-80, -100, -100])];
    const bvh = BVH.build(meshes);
    expect(bvh.queryAABB(box(-91, -101, -101, -89, -99, -99))).toEqual([2]);
  });

  it('reports every mesh at a coincident location (duplicate bounds)', () => {
    const meshes = [cube(1, [0, 0, 0]), cube(2, [0, 0, 0]), cube(3, [0, 0, 0])];
    const bvh = BVH.build(meshes);
    expect(bvh.queryAABB(box(0, 0, 0, 0, 0, 0)).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe('BVH.raycast', () => {
  it('hits meshes along the ray and skips the ones off-axis', () => {
    const bvh = BVH.build([cube(1, [10, 0, 0]), cube(2, [20, 0, 0]), cube(3, [30, 50, 0])]);
    expect(bvh.raycast([0, 0, 0], [1, 0, 0]).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('does NOT report meshes behind the ray origin', () => {
    // Cube at x = -10, ray fired towards +x from the origin. The slab test's
    // `tmax >= 0` is the only thing that rejects it; without it every mesh on
    // the infinite LINE would be reported and viewer picking would select an
    // element behind the camera.
    const bvh = BVH.build([cube(1, [-10, 0, 0]), cube(2, [10, 0, 0])]);
    expect(bvh.raycast([0, 0, 0], [1, 0, 0])).toEqual([2]);
    // Reversing the direction swaps which one is visible.
    expect(bvh.raycast([0, 0, 0], [-1, 0, 0])).toEqual([1]);
  });

  it('handles an axis-parallel ray without NaN poisoning the slab test', () => {
    // direction has two exact zeros: the parallel-slab guard must reject on the
    // axes the ray does not advance along, instead of computing 0 * Infinity.
    const bvh = BVH.build([cube(1, [0, 0, 30]), cube(2, [0, 40, 30])]);
    // Ray along +z through x=0,y=0 — hits cube 1, misses cube 2 (y=40).
    expect(bvh.raycast([0, 0, 0], [0, 0, 1])).toEqual([1]);
    // Same ray offset in y so it misses everything.
    expect(bvh.raycast([0, 20, 0], [0, 0, 1])).toEqual([]);
  });

  it('grazes a slab plane exactly, on an axis the ray does not advance along', () => {
    // Cube 1 spans x,y ∈ [-0.5, 0.5]. The ray runs along +z with direction
    // x = y = 0 and its origin sits EXACTLY on the x = -0.5 face plane. Without
    // the parallel-slab guard the slab math evaluates (min.x - origin.x) * (1/0)
    // = 0 * Infinity = NaN, every subsequent comparison is false, and the hit is
    // silently DROPPED — a viewer click that grazes an element edge selects
    // nothing. Both faces of both grazed axes are checked.
    const bvh = BVH.build([cube(1, [0, 0, 30])]);
    expect(bvh.raycast([-0.5, 0, 0], [0, 0, 1])).toEqual([1]);
    expect(bvh.raycast([0.5, 0, 0], [0, 0, 1])).toEqual([1]);
    expect(bvh.raycast([0, -0.5, 0], [0, 0, 1])).toEqual([1]);
    expect(bvh.raycast([0, 0.5, 0], [0, 0, 1])).toEqual([1]);
    // A hair outside the same face is still correctly a miss, so the test above
    // cannot be satisfied by simply accepting every parallel ray.
    expect(bvh.raycast([-0.5001, 0, 0], [0, 0, 1])).toEqual([]);
  });

  it('reports a hit when the ray origin sits exactly on the exit face, pointing away', () => {
    // Cube spans -0.5..0.5 on every axis. Origin at x=0.5 (the +x face),
    // direction +x (away from the cube). The slab math resolves tmax to
    // exactly 0 here (not the parallel-axis case covered above — direction
    // is non-zero on the axis that produces the boundary). AABBUtils.intersects
    // and the BVH itself are both inclusive at an exact touch (`<=`/`>=`);
    // `tmax >= 0` is what keeps this consistent for the ray case. `tmax > 0`
    // also passes every other test in this file, so only this exact-touch
    // origin distinguishes the two.
    const bvh = BVH.build([cube(1, [0, 0, 0])]);
    expect(bvh.raycast([0.5, 0, 0], [1, 0, 0])).toEqual([1]);
  });

  it('reports a hit when the ray starts inside a mesh', () => {
    const bvh = BVH.build([cube(1, [0, 0, 0], 5)]);
    expect(bvh.raycast([0, 0, 0], [1, 0, 0])).toEqual([1]);
  });

  it('normalizes the direction — magnitude does not change the hit set', () => {
    const bvh = BVH.build([cube(1, [10, 0, 0]), cube(2, [20, 0, 0])]);
    const unit = bvh.raycast([0, 0, 0], [1, 0, 0]).sort((a, b) => a - b);
    const long = bvh.raycast([0, 0, 0], [1000, 0, 0]).sort((a, b) => a - b);
    expect(long).toEqual(unit);
    // The magnitude-invariance above is NOT evidence that the normalization
    // runs: the slab test scales every `t` by the same positive factor, so the
    // hit SET is invariant under any positive scaling and deleting the
    // normalization outright leaves both assertions green (measured). The
    // degenerate direction is the one input where the normalization is
    // observable: it divides by a zero length, every component becomes NaN,
    // and the slab test rejects — a zero-length ray hits nothing. Skip the
    // normalization and the same call takes the parallel-slab branch on all
    // three axes instead and reports every mesh containing the origin, so a
    // viewer picking with a degenerate direction would select the element the
    // camera sits inside.
    const inside = BVH.build([cube(1, [0, 0, 0], 5)]);
    expect(inside.raycast([0, 0, 0], [1, 0, 0])).toEqual([1]);
    expect(inside.raycast([0, 0, 0], [0, 0, 0])).toEqual([]);
  });
});

describe('BVH.queryFrustum', () => {
  /** Axis-aligned "box frustum": six inward-facing planes bounding a cuboid. */
  function boxFrustum(b: AABB): Frustum {
    return {
      planes: [
        { normal: [1, 0, 0], distance: -b.min[0] },
        { normal: [-1, 0, 0], distance: b.max[0] },
        { normal: [0, 1, 0], distance: -b.min[1] },
        { normal: [0, -1, 0], distance: b.max[1] },
        { normal: [0, 0, 1], distance: -b.min[2] },
        { normal: [0, 0, -1], distance: b.max[2] },
      ],
    };
  }

  it('returns only meshes inside the frustum volume', () => {
    const bvh = BVH.build(row(20));
    // Wide enough that the -0.5 m plane epsilon cannot reach the neighbours,
    // which sit 10 m away.
    const hits = bvh.queryFrustum(boxFrustum(box(25, -5, -5, 45, 5, 5))).sort((a, b) => a - b);
    expect(hits).toEqual([103, 104]);
  });

  it('culls everything when the frustum is far from the scene', () => {
    const bvh = BVH.build(row(20));
    expect(bvh.queryFrustum(boxFrustum(box(1000, 1000, 1000, 1100, 1100, 1100)))).toEqual([]);
  });

  it('keeps a batch just outside the frustum edge (the anti-flicker margin)', () => {
    // Cube spans -0.5..0.5, so its positive vertex on +x is 0.5. The frustum's
    // left plane cuts at x = 0.7, putting that vertex 0.2 m BEHIND the plane —
    // strictly outside. FrustumUtils tolerates up to 0.5 m of overshoot so a
    // batch grazing the edge does not pop in and out while orbiting; with a
    // zero margin this batch would be culled and flicker.
    const bvh = BVH.build([cube(1, [0, 0, 0])]);
    expect(bvh.queryFrustum(boxFrustum(box(0.7, -5, -5, 10, 5, 5)))).toEqual([1]);
    // Beyond the margin it IS culled — so the assertion above is not satisfied
    // by a "keep everything" frustum test.
    expect(bvh.queryFrustum(boxFrustum(box(1.1, -5, -5, 10, 5, 5)))).toEqual([]);
  });
});

describe('FrustumUtils', () => {
  it('normalizes planes extracted from a view-projection matrix', () => {
    // Simple orthographic-ish matrix; the only invariant asserted here is that
    // every extracted plane normal is unit length after normalization. On its
    // own that is weak — it says nothing about the plane CONSTANTS or about
    // which matrix rows each plane comes from; the test below covers both.
    const m = [
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const f = FrustumUtils.fromViewProjMatrix(m);
    expect(f.planes).toHaveLength(6);
    for (const p of f.planes) {
      const len = Math.hypot(p.normal[0], p.normal[1], p.normal[2]);
      expect(len).toBeCloseTo(1, 10);
    }
  });

  it('extracts the six planes of a known orthographic volume, in world units', () => {
    // Column-major orthographic view-proj for x,y ∈ [-10, 10], z ∈ [0, 20]
    // (WebGPU clip space, z ∈ [0, 1] — matching the near-plane extraction,
    // which uses row 2 alone rather than w + row 2).
    const m = [
      0.1, 0, 0, 0,
      0, 0.1, 0, 0,
      0, 0, 0.05, 0,
      0, 0, 0, 1,
    ];
    const f = FrustumUtils.fromViewProjMatrix(m);

    // Culling decisions are taken in WORLD units against the -0.5 m margin, so
    // they only come out right if the plane constant was divided by the normal
    // length too. Skipping `plane.distance /= len` leaves every normal unit
    // length — the assertion above still passes — while the left plane moves
    // from x = -10 to x = -15, and this box (5 m outside, 2 m outside the
    // margin) is then wrongly kept.
    const cell = (cx: number, cy: number, cz: number): AABB =>
      box(cx - 0.5, cy - 0.5, cz - 0.5, cx + 0.5, cy + 0.5, cz + 0.5);

    // Inside the volume on every axis.
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 10))).toBe(true);
    // Just inside each face (within the volume, so kept with or without margin).
    expect(FrustumUtils.isAABBVisible(f, cell(-9, 0, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(9, 0, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, -9, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 9, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 1))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 19))).toBe(true);
    // Well outside each face — one assertion per plane, so a single mis-wired
    // plane cannot hide behind the other five.
    expect(FrustumUtils.isAABBVisible(f, cell(-12, 0, 10))).toBe(false); // left
    expect(FrustumUtils.isAABBVisible(f, cell(12, 0, 10))).toBe(false); // right
    expect(FrustumUtils.isAABBVisible(f, cell(0, -12, 10))).toBe(false); // bottom
    expect(FrustumUtils.isAABBVisible(f, cell(0, 12, 10))).toBe(false); // top
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, -2))).toBe(false); // near
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 22))).toBe(false); // far
  });

  it('extracts the six planes under a dense rotation, where no matrix entry is zero', () => {
    // The axis-aligned fixture above pins each plane's CONSTANT, but not which
    // matrix entry every normal COMPONENT comes from: it is diagonal, so
    // m[1], m[2], m[4], m[6], m[8] and m[9] are all zero and swapping one for
    // another is an identity. Measured on that fixture alone: the bottom plane
    // reading `m[2]` instead of `m[1]`, and the near plane reading `m[6]`
    // instead of `m[2]`, both SURVIVE. A rotated view leaves no zero entry in
    // the upper 3x3, so a component read from the wrong row is observable.
    const rot = rotationAboutAxis([1, 2, 3], 0.7); // rot[r][c], world -> view
    for (const r of rot) for (const v of r) expect(Math.abs(v)).toBeGreaterThan(0.05);

    // View volume: x ∈ [-10, 10], y ∈ [-5, 5], z ∈ [0, 20]. Deliberately
    // different extents per axis, so a swap between two planes is not masked
    // by a symmetric volume. m = P · rot, column-major.
    const scale = [0.1, 0.2, 0.05];
    const m = [
      ...[0, 1, 2].flatMap((c) => [
        scale[0] * rot[0][c], scale[1] * rot[1][c], scale[2] * rot[2][c], 0,
      ]),
      0, 0, 0, 1,
    ];
    const f = FrustumUtils.fromViewProjMatrix(m);

    // A view-space point mapped back to world by the inverse rotation (the
    // transpose): the expectations are derived from the fixture rotation, not
    // from `fromViewProjMatrix`.
    const cell = (vx: number, vy: number, vz: number): AABB => {
      const wx = rot[0][0] * vx + rot[1][0] * vy + rot[2][0] * vz;
      const wy = rot[0][1] * vx + rot[1][1] * vy + rot[2][1] * vz;
      const wz = rot[0][2] * vx + rot[1][2] * vy + rot[2][2] * vz;
      return box(wx - 0.5, wy - 0.5, wz - 0.5, wx + 0.5, wy + 0.5, wz + 0.5);
    };

    // Inside on every axis, then just inside each face.
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(-9, 0, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(9, 0, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, -4, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 4, 10))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 2))).toBe(true);
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 18))).toBe(true);
    // Every corner of the volume, all still inside. Probing each plane only
    // along its OWN axis is not enough: a normal component read from the wrong
    // row can leave the sign of that one dot product unchanged (measured — the
    // near plane taking its x from `m[6]` instead of `m[2]` survives the
    // face-centre probes above). A corner loads every component at once, so a
    // mis-wired one tilts the plane into the volume and clips the corner off.
    for (const vx of [-9, 9]) {
      for (const vy of [-4, 4]) {
        for (const vz of [1, 19]) {
          expect(FrustumUtils.isAABBVisible(f, cell(vx, vy, vz))).toBe(true);
        }
      }
    }
    // Well outside each face, one assertion per plane. The cells are cubes in
    // WORLD space, so their half-diagonal (0.87 m) is the slack a plane test
    // sees; 2 m outside clears it and the -0.5 m margin both.
    expect(FrustumUtils.isAABBVisible(f, cell(-12, 0, 10))).toBe(false); // left
    expect(FrustumUtils.isAABBVisible(f, cell(12, 0, 10))).toBe(false); // right
    expect(FrustumUtils.isAABBVisible(f, cell(0, -7, 10))).toBe(false); // bottom
    expect(FrustumUtils.isAABBVisible(f, cell(0, 7, 10))).toBe(false); // top
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, -2))).toBe(false); // near
    expect(FrustumUtils.isAABBVisible(f, cell(0, 0, 22))).toBe(false); // far
  });

  it('leaves a degenerate zero-length plane normal untouched instead of producing NaN', () => {
    const m = new Array(16).fill(0);
    const f = FrustumUtils.fromViewProjMatrix(m);
    for (const p of f.planes) {
      expect(p.normal.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(p.distance)).toBe(true);
    }
  });

  it('uses the positive vertex — a box is kept while ANY corner is inside', () => {
    const b = box(-1, -1, -1, 1, 1, 1);
    // Plane facing +x, cutting at x = 0.9: the box's +x corner (x = 1) is in
    // front of it, so the box must survive. Testing the min corner instead
    // (or the centre) would wrongly cull it.
    const f: Frustum = { planes: [{ normal: [1, 0, 0], distance: -0.9 }] };
    expect(FrustumUtils.isAABBVisible(f, b)).toBe(true);
    // Move the plane past the far corner by more than the 0.5 m margin.
    const far: Frustum = { planes: [{ normal: [1, 0, 0], distance: -1.6 }] };
    expect(FrustumUtils.isAABBVisible(far, b)).toBe(false);
  });

  it('keeps an AABB up to half a metre behind the plane, and no further', () => {
    const b = box(-1, -1, -1, 1, 1, 1); // positive vertex on +x is 1
    // Plane at x = 1.4 → positive vertex 0.4 m behind it: within the margin.
    expect(FrustumUtils.isAABBVisible({ planes: [{ normal: [1, 0, 0], distance: -1.4 }] }, b)).toBe(true);
    // Plane at x = 1.6 → 0.6 m behind: past the margin, culled.
    expect(FrustumUtils.isAABBVisible({ planes: [{ normal: [1, 0, 0], distance: -1.6 }] }, b)).toBe(false);
  });

  it('keeps an AABB exactly at the margin boundary, and culls a hair past it', () => {
    // Positive vertex on +x is 1. Plane at x = 1.5 puts it exactly 0.5 m
    // behind the plane — precisely PLANE_EPSILON. `distance < EPSILON` keeps
    // this (distance === EPSILON does not satisfy strict '<'); `distance <=
    // EPSILON` would wrongly cull it, and every other test in this file
    // (which all use a 0.1 m margin either side of the boundary) still
    // passes under that mutant.
    const b = box(-1, -1, -1, 1, 1, 1);
    expect(FrustumUtils.isAABBVisible({ planes: [{ normal: [1, 0, 0], distance: -1.5 }] }, b)).toBe(true);
    // A hair past the boundary is culled either way — distinguishes "exact
    // boundary" from "always keep".
    expect(FrustumUtils.isAABBVisible({ planes: [{ normal: [1, 0, 0], distance: -1.500001 }] }, b)).toBe(false);
  });

  it('applies the same positive-vertex rule for a negative-facing normal', () => {
    const b = box(-1, -1, -1, 1, 1, 1);
    const f: Frustum = { planes: [{ normal: [-1, 0, 0], distance: -0.9 }] };
    expect(FrustumUtils.isAABBVisible(f, b)).toBe(true);
    const far: Frustum = { planes: [{ normal: [-1, 0, 0], distance: -1.6 }] };
    expect(FrustumUtils.isAABBVisible(far, b)).toBe(false);
  });
});
