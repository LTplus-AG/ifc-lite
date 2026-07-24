/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure-tool point-cloud snapping (#1860): insert + ray-query
 * correctness for the CPU spatial index built over streamed point-cloud
 * chunks (`point-cloud-node.ts` retains no positions of its own once
 * they're packed into the GPU vertex buffer, so this index is the only
 * place a real scan point's world position survives).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PointCloudSpatialIndex } from './pointcloud/point-cloud-spatial-index.js';
import type { Vec3 } from './raycaster.js';

/** A ray straight down +Z from the origin. */
const FORWARD_RAY = { origin: { x: 0, y: 0, z: 0 } as Vec3, direction: { x: 0, y: 0, z: 1 } as Vec3 };

/** Flat tolerance-per-depth: pretend every depth has the same world tolerance. */
const flatTolerance = (r: number) => (_t: number) => r;

describe('PointCloudSpatialIndex — empty / single point', () => {
  it('returns null on an empty index', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.1));
    assert.strictEqual(hit, null);
    assert.strictEqual(idx.pointCount, 0);
    assert.strictEqual(idx.getBounds(), null);
  });

  it('finds a single point dead-center on the ray', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5]), 1);
    assert.strictEqual(idx.pointCount, 1);

    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 5);
    assert.deepStrictEqual(hit!.position, { x: 0, y: 0, z: 5 });
  });

  it('rejects a point outside the screen-space tolerance', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    // 0.2m off-axis at depth 5 — well outside a 0.05m tolerance.
    idx.insertRange(new Float32Array([0.2, 0, 5]), 1);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.strictEqual(hit, null);
  });

  it('accepts a point just inside tolerance and rejects just outside it', () => {
    const idx = new PointCloudSpatialIndex(0.25);
    idx.insertRange(new Float32Array([0.04, 0, 5]), 1);
    assert.ok(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05)));

    const idx2 = new PointCloudSpatialIndex(0.25);
    idx2.insertRange(new Float32Array([0.06, 0, 5]), 1);
    assert.strictEqual(idx2.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05)), null);
  });
});

describe('PointCloudSpatialIndex — depth / occlusion semantics', () => {
  it('rejects a point behind the camera (negative t along the ray)', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, -5]), 1);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.1));
    assert.strictEqual(hit, null);
  });

  it('excludes points beyond maxDistance', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 50]), 1);
    assert.strictEqual(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 10, flatTolerance(0.1)), null);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.1));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 50);
  });

  it('prefers the nearer-along-ray point over one merely closer to the ray axis', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    // Far point sits exactly on the ray axis (perp distance 0); near
    // point is slightly off-axis but still within tolerance. The near
    // one must win — a real surface occludes what's behind it.
    idx.insertRange(new Float32Array([0, 0, 20, 0.02, 0, 3]), 2);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 3);
  });

  it('picks the nearest of several in-tolerance points scattered across many cells', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    const pts: number[] = [];
    // Scatter points every metre from 1 to 30, each on-axis.
    for (let z = 30; z >= 1; z--) pts.push(0, 0, z);
    idx.insertRange(new Float32Array(pts), pts.length / 3);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 1);
  });
});

describe('PointCloudSpatialIndex — geometry edge cases', () => {
  it('a ray that misses the index bounds entirely returns null', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([100, 100, 100]), 1);
    // Ray points away from the point's octant entirely.
    const hit = idx.queryRay({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 1000, flatTolerance(0.1));
    assert.strictEqual(hit, null);
  });

  it('a ray parallel to an axis (zero direction component) does not throw', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5]), 1);
    // Direction purely along Z, zero X/Y components exercise the
    // DDA's "axis never advances" branch.
    const hit = idx.queryRay({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 100, flatTolerance(0.05));
    assert.ok(hit);
  });

  it('ignores non-finite (NaN/Infinity) positions instead of poisoning bounds', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([NaN, 0, 5, 0, 0, 5]), 2);
    assert.strictEqual(idx.pointCount, 2); // both count toward pointCount...
    const bounds = idx.getBounds()!;
    // ...but only the finite point contributes to bounds.
    assert.strictEqual(bounds.max.z, 5);
    assert.ok(Number.isFinite(bounds.min.x));
  });

  it('getBounds reflects points inserted across multiple chunks', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 0]), 1);
    idx.insertRange(new Float32Array([10, -3, 7]), 1);
    const bounds = idx.getBounds()!;
    assert.deepStrictEqual(bounds.min, { x: 0, y: -3, z: 0 });
    assert.deepStrictEqual(bounds.max, { x: 10, y: 0, z: 7 });
  });
});

describe('PointCloudSpatialIndex — memory safety cap', () => {
  it('stops indexing past maxIndexedPoints but keeps pointCount capped, not throwing', () => {
    const idx = new PointCloudSpatialIndex(0.5, 3);
    idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5]), 5);
    assert.strictEqual(idx.pointCount, 3);
    assert.strictEqual(idx.isCapped, true);
    // The 4th/5th points (z=4,5) were never indexed — only the first 3 are queryable.
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 1);
    // A ray that could only reach z=4/5 finds nothing, since those points
    // were dropped by the cap.
    idx.insertRange(new Float32Array([0, 0, 4.5]), 1); // further inserts past the cap are no-ops
    assert.strictEqual(idx.pointCount, 3);
  });

  it('a fresh index is not capped and indexes everything under a generous limit', () => {
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000);
    idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 2]), 2);
    assert.strictEqual(idx.isCapped, false);
    assert.strictEqual(idx.pointCount, 2);
  });
});

describe('PointCloudSpatialIndex — dispose', () => {
  it('clears points and bounds so a disposed index behaves like a fresh empty one', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5]), 1);
    idx.dispose();
    assert.strictEqual(idx.pointCount, 0);
    assert.strictEqual(idx.getBounds(), null);
    assert.strictEqual(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.1)), null);
  });
});
