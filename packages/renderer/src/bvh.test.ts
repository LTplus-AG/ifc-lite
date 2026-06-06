/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BVH } from './bvh.js';
import type { Ray } from './raycaster.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * The BVH is a conservative broad-phase: `getMeshesForRay` may return extra
 * candidates, but it must never DROP a mesh whose AABB the ray actually crosses
 * (that would make picking/snapping miss real geometry). These tests pin that
 * "no false negatives" invariant against a brute-force reference, plus the
 * degenerate cases (small scene, unbuilt, empty mesh).
 */

interface AABBLike {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

// Axis-aligned cube (8 corners) centred at (cx,cy,cz) with half-size h.
function boxMesh(expressId: number, cx: number, cy: number, cz: number, h = 0.4): MeshData {
  const c: number[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        c.push(cx + sx * h, cy + sy * h, cz + sz * h);
      }
    }
  }
  return {
    expressId,
    positions: new Float32Array(c),
    normals: new Float32Array(c.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [0, 0, 0, 1],
    name: `box-${expressId}`,
  } as unknown as MeshData;
}

// Mesh with no vertices — its AABB stays Infinity/-Infinity (contributes nothing
// to a union, yields a NaN centroid), so every node it lands in is pruned.
function emptyMesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    color: [0, 0, 0, 1],
    name: `empty-${expressId}`,
  } as unknown as MeshData;
}

function meshAabb(m: MeshData): AABBLike {
  const p = m.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]);
    minY = Math.min(minY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]);
    maxX = Math.max(maxX, p[i]);
    maxY = Math.max(maxY, p[i + 1]);
    maxZ = Math.max(maxZ, p[i + 2]);
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

// Slab test mirroring BVH.rayIntersectsAABB, used as the ground truth.
function rayHitsAabb(ray: Ray, b: AABBLike): boolean {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const ax of ['x', 'y', 'z'] as const) {
    if (Math.abs(ray.direction[ax]) < 0.0000001) {
      if (ray.origin[ax] < b.min[ax] || ray.origin[ax] > b.max[ax]) return false;
    } else {
      const inv = 1 / ray.direction[ax];
      let t0 = (b.min[ax] - ray.origin[ax]) * inv;
      let t1 = (b.max[ax] - ray.origin[ax]) * inv;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
      }
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
      if (tmin > tmax) return false;
    }
  }
  return tmax >= 0;
}

function bruteForceHits(ray: Ray, meshes: MeshData[]): Set<number> {
  const out = new Set<number>();
  meshes.forEach((m, i) => {
    if (rayHitsAabb(ray, meshAabb(m))) out.add(i);
  });
  return out;
}

// 6×6 grid of cubes in the z=0 plane (36 meshes > maxMeshesPerLeaf=8, so the
// tree actually splits), plus a few stacked in z to exercise the third axis.
function gridScene(): MeshData[] {
  const meshes: MeshData[] = [];
  let id = 1;
  for (let x = 0; x < 6; x++) {
    for (let y = 0; y < 6; y++) {
      meshes.push(boxMesh(id++, x, y, 0));
    }
  }
  for (let z = 1; z <= 4; z++) {
    meshes.push(boxMesh(id++, 2, 2, z));
  }
  return meshes;
}

describe('BVH', () => {
  it('never drops a mesh the ray actually crosses (superset of brute force)', () => {
    const meshes = gridScene();
    const bvh = new BVH();
    bvh.build(meshes);

    const rays: Ray[] = [
      // Straight down through the (2,2) column.
      { origin: { x: 2, y: 2, z: 10 }, direction: { x: 0, y: 0, z: -1 } },
      // Along +x sweeping the y=3 row at z=0.
      { origin: { x: -10, y: 3, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
      // Along +y sweeping the x=5 column at z=0.
      { origin: { x: 5, y: -10, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
      // Diagonal through the grid.
      { origin: { x: -5, y: -5, z: 5 }, direction: { x: 1, y: 1, z: -1 } },
      // Clear miss, well outside every AABB.
      { origin: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 } },
    ];

    for (const ray of rays) {
      const brute = bruteForceHits(ray, meshes);
      const candidates = new Set(bvh.getMeshesForRay(ray, meshes));
      for (const idx of brute) {
        assert.ok(
          candidates.has(idx),
          `ray ${JSON.stringify(ray.origin)}→${JSON.stringify(ray.direction)} dropped mesh ${idx} (true AABB hit)`
        );
      }
      // Candidates must be valid indices into the mesh array.
      for (const idx of candidates) {
        assert.ok(idx >= 0 && idx < meshes.length, `candidate index ${idx} out of range`);
      }
    }
  });

  it('finds the expected count on an axis sweep', () => {
    const meshes = gridScene();
    const bvh = new BVH();
    bvh.build(meshes);

    // +x ray at y=3,z=0 crosses exactly the 6 cubes of the y=3 row.
    const ray: Ray = { origin: { x: -10, y: 3, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    const brute = bruteForceHits(ray, meshes);
    assert.strictEqual(brute.size, 6);
    const candidates = new Set(bvh.getMeshesForRay(ray, meshes));
    for (const idx of brute) assert.ok(candidates.has(idx));
  });

  it('handles a small scene (≤ leaf size) without dropping hits', () => {
    const meshes = [boxMesh(1, 0, 0, 0), boxMesh(2, 5, 0, 0), boxMesh(3, 0, 5, 0)];
    const bvh = new BVH();
    bvh.build(meshes);
    const ray: Ray = { origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    const candidates = new Set(bvh.getMeshesForRay(ray, meshes));
    assert.ok(candidates.has(0)); // the cube at the origin
  });

  it('returns all indices when not built', () => {
    const meshes = [boxMesh(1, 0, 0, 0), boxMesh(2, 1, 0, 0)];
    const bvh = new BVH();
    const ray: Ray = { origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    assert.deepStrictEqual(bvh.getMeshesForRay(ray, meshes), [0, 1]);
  });

  it('prunes a clear miss to zero candidates', () => {
    const meshes = gridScene();
    const bvh = new BVH();
    bvh.build(meshes);
    // Far outside every AABB → the root node must be pruned, no candidates.
    const ray: Ray = { origin: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 } };
    assert.strictEqual(bruteForceHits(ray, meshes).size, 0);
    assert.strictEqual(bvh.getMeshesForRay(ray, meshes).length, 0);
  });

  it('does not break when a mesh has no vertices (mixed with real ones)', () => {
    const meshes = [...gridScene(), emptyMesh(999)];
    const bvh = new BVH();
    assert.doesNotThrow(() => bvh.build(meshes));
    const ray: Ray = { origin: { x: 2, y: 2, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    const brute = bruteForceHits(ray, meshes);
    const candidates = new Set(bvh.getMeshesForRay(ray, meshes));
    for (const idx of brute) assert.ok(candidates.has(idx));
  });

  it('builds from only empty meshes without throwing or returning candidates', () => {
    // > maxMeshesPerLeaf (8) empty meshes so the tree splits into all-empty leaves.
    const meshes = Array.from({ length: 12 }, (_, i) => emptyMesh(i + 1));
    const bvh = new BVH();
    assert.doesNotThrow(() => bvh.build(meshes));
    // Every node has an Infinity/-Infinity AABB, so all rays prune to nothing.
    const ray: Ray = { origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    assert.strictEqual(bvh.getMeshesForRay(ray, meshes).length, 0);
  });
});
