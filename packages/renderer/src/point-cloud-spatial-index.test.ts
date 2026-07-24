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

describe('PointCloudSpatialIndex — dynamic dilation radius (#1860 review finding 1)', () => {
  it('finds a far, off-axis point that a fixed +-1-cell neighborhood would miss', () => {
    // cellSize=0.5 -> a fixed +-1 cell dilation only covers +-0.5m
    // perpendicular to the ray. A wide-FOV / zoomed-out query at long
    // range needs a much bigger world tolerance than that — here the
    // point sits 1.5m off-axis at t=120m, and toleranceAt admits up to
    // 2m at any depth (simulating what screenToWorldRadius produces at
    // long range for an ~8px tolerance). This FAILS without the dynamic
    // per-cell radius (old code only ever tested +-1 cell = +-0.5m).
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([1.5, 0, 120]), 1);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 1000, flatTolerance(2.0));
    assert.ok(hit, 'expected the far off-axis point to be found once dilation covers its offset');
    assert.strictEqual(hit!.distance, 120);
    assert.ok(Math.abs(hit!.position.x - 1.5) < 1e-9);
  });

  it('still finds a far off-axis point when toleranceAt genuinely grows with depth', () => {
    // A more realistic toleranceAt: grows linearly with t (mirrors
    // screenToWorldRadius), so the world tolerance at t=100 is 5cm,
    // small at short range but exceeds one 0.5m cell at long range.
    const growingTolerance = (t: number) => Math.max(0.01, t * 0.02); // ~2cm per metre of depth
    const idx = new PointCloudSpatialIndex(0.5);
    // At t=100, growingTolerance = 2.0m; point sits 1.8m off axis.
    idx.insertRange(new Float32Array([1.8, 0, 100]), 1);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 1000, growingTolerance);
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 100);
  });

  it('perf-sanity: the dilation radius (and thus effective snap radius) is capped even under a huge tolerance', () => {
    // toleranceAt returns an enormous value at every depth — without a
    // cap this would force the march to search an ever-growing cell
    // neighborhood (unbounded work per step). MAX_DILATION_RADIUS_CELLS
    // (4, at 0.5m cells) bounds the effective world search radius to 2m
    // regardless of how large toleranceAt claims to be.
    const hugeTolerance = () => 100;

    // Within the cap (1.9m < 2m effective radius): found.
    const withinCap = new PointCloudSpatialIndex(0.5);
    withinCap.insertRange(new Float32Array([1.9, 0, 50]), 1);
    assert.ok(withinCap.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 1000, hugeTolerance));

    // Beyond the cap (2.5m > 2m effective radius): NOT found, even
    // though `hugeTolerance` would otherwise happily admit it (100 >> 2.5).
    const beyondCap = new PointCloudSpatialIndex(0.5);
    beyondCap.insertRange(new Float32Array([2.5, 0, 50]), 1);
    assert.strictEqual(
      beyondCap.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 1000, hugeTolerance),
      null,
      'a point beyond MAX_DILATION_RADIUS_CELLS * cellSize must not be found regardless of toleranceAt',
    );
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
