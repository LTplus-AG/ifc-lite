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

import {
  DEFAULT_MAX_INDEXED_CELLS,
  DEFAULT_MAX_INDEXED_POINTS,
  DEFAULT_POINTCLOUD_INDEX_CELL_SIZE,
  PointCloudSpatialIndex,
  V8_MAP_MAX_ENTRIES,
} from './pointcloud/point-cloud-spatial-index.js';
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

  it('maxDistance = Infinity (no mesh hit on the ray) returns the nearest point and terminates', () => {
    // This is the real production path when the scene has no mesh under
    // the cursor: RaycastEngine passes `Infinity` as the bound. queryRay
    // must clamp the march to the index's bounding-box exit (tMax is the
    // box exit, not Infinity) and still return the nearest-along-ray point.
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5, 0, 0, 250]), 2);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, Infinity, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 5);
  });

  it('maxDistance = Infinity with a total miss across a huge (50km) cloud terminates with null', () => {
    // Degenerate-but-reachable: point-cloud-only scene, cursor over empty
    // space, un-rebased georeferenced extents. The ray starts INSIDE the
    // cloud's bounding box (so the bbox pre-cull cannot reject it — the
    // DDA genuinely marches) and misses every point; MAX_MARCH_CELLS must
    // bound the walk (without it this marched ~200k cells, 0.2-4.4s per
    // query — CodeRabbit CLI review, PR #1875), returning null promptly.
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 0, 50_000, 1, 50_000]), 2);
    const hit = idx.queryRay(
      { x: 10, y: 0.5, z: 0 },
      { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 },
      Infinity,
      flatTolerance(0.05),
    );
    assert.strictEqual(hit, null);
  });

  it('the march-step cap preserves practical-range snaps and cuts off only beyond-useful depths', () => {
    // MAX_MARCH_CELLS (8192) bounds per-query work independent of cloud
    // extent. At 0.5m cells an axis-aligned march covers ~4km of ray
    // travel from the box entry — a snap 1km deep must still work, while
    // a point 10km deep (sub-pixel snap zone at any practical zoom, see
    // MAX_MARCH_CELLS docs) is unreachable by design.
    const anchor = [0, 5, 0]; // pins the box near the origin; 5m off-axis, never in tolerance
    const within = new PointCloudSpatialIndex(0.5);
    within.insertRange(new Float32Array([...anchor, 1_000, 0, 0]), 2);
    const hitWithin = within.queryRay({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, Infinity, flatTolerance(0.05));
    assert.ok(hitWithin, 'a 1km-deep point (well within the march cap) must still snap');
    assert.strictEqual(hitWithin!.position.x, 1_000);

    const beyond = new PointCloudSpatialIndex(0.5);
    beyond.insertRange(new Float32Array([...anchor, 10_000, 0, 0]), 2);
    assert.strictEqual(
      beyond.queryRay({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, Infinity, flatTolerance(0.05)),
      null,
      'a 10km-deep point is beyond the bounded march (and beyond any usable snap zone)',
    );
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

describe('PointCloudSpatialIndex — occupied-cell cap (#3028 diagnosis)', () => {
  /**
   * The grid is a `Map<number, number[]>` with ONE ENTRY PER OCCUPIED
   * CELL, and `insertRange` can create a new cell for every point it
   * indexes. V8 throws `RangeError: Map maximum size exceeded` at exactly
   * 2^24 entries (verified by running: an int-keyed `Map` insert loop
   * throws with `map.size === 16_777_216`).
   *
   * So the point cap alone cannot protect the Map. On a SPARSE cloud —
   * airborne LiDAR or a coarse site scan, roughly one point per 0.5 m cell
   * — occupied cells track indexed points nearly 1:1, and the point cap
   * (30M) sits ABOVE the engine ceiling: the Map throws long before the
   * "safety valve" can bind. Dense terrestrial scans put many points in a
   * single cell and never approach it, which is why this went unnoticed.
   */
  it('cannot create more cells than V8 can hold, even at one point per cell', () => {
    // `insertRange` adds at most one Map entry per indexed point, so the
    // worst case (a fully sparse cloud) is cells === points indexed. The
    // index stops at whichever cap binds first.
    const worstCaseCells = Math.min(DEFAULT_MAX_INDEXED_POINTS, DEFAULT_MAX_INDEXED_CELLS);
    assert.ok(
      worstCaseCells < V8_MAP_MAX_ENTRIES,
      `a sparse cloud can occupy ${worstCaseCells} cells, at or above V8's ` +
        `${V8_MAP_MAX_ENTRIES}-entry Map limit — the grid throws before the valve binds`,
    );
  });

  it("pins V8's Map entry ceiling at 2**24", () => {
    // Verified by running against this repo's Node: an int-keyed Map insert
    // loop throws `RangeError: Map maximum size exceeded` at size 16,777,216.
    assert.strictEqual(V8_MAP_MAX_ENTRIES, 16_777_216);
  });

  it('leaves real headroom below the ceiling rather than sitting on it', () => {
    assert.ok(DEFAULT_MAX_INDEXED_CELLS <= V8_MAP_MAX_ENTRIES - (1 << 20));
    // ...but binds only where V8 would otherwise have thrown: no cloud that
    // indexes fully today may lose coverage to the new limb.
    assert.ok(DEFAULT_MAX_INDEXED_CELLS >= V8_MAP_MAX_ENTRIES / 2);
  });

  it('stops indexing when the cell cap binds, and reports "cells" as the reason', () => {
    // Cheap repro of the sparse-cloud shape: points 1 m apart at a 0.5 m
    // cell size land one per cell, so cells === points. Budget: 4 cells.
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 4);
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) pts.push(0, 0, 1 + i);
    idx.insertRange(new Float32Array(pts), 10);

    assert.strictEqual(idx.cellCount, 4, 'grid must not grow past the cell cap');
    assert.strictEqual(idx.pointCount, 4, 'points past the cell cap are not indexed');
    assert.strictEqual(idx.isCapped, true);
    assert.strictEqual(idx.capReason, 'cells', 'the reported reason must name the limb that bound');

    // The accepted prefix is still queryable — a bound index degrades, it
    // does not break.
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 1);

    // Bounds cover only what was indexed, so getBounds never advertises a
    // region queryRay cannot reach.
    const bounds = idx.getBounds();
    assert.ok(bounds);
    assert.strictEqual(bounds!.max.z, 4);

    // Further inserts are no-ops once the index is closed.
    idx.insertRange(new Float32Array([0, 0, 50]), 1);
    assert.strictEqual(idx.pointCount, 4);
    assert.strictEqual(idx.cellCount, 4);
  });

  it('spends no cell budget on points landing in an already-occupied cell', () => {
    // Dense shape: 10 points inside ONE 0.5 m cell. One Map entry, so a
    // 1-cell budget indexes all ten — this limb bounds the Map, not points.
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 1);
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) pts.push(0, 0, 0.01 + i * 0.04);
    idx.insertRange(new Float32Array(pts), 10);
    assert.strictEqual(idx.cellCount, 1);
    assert.strictEqual(idx.pointCount, 10);
    assert.strictEqual(idx.isCapped, false);
    assert.strictEqual(idx.capReason, null);
  });

  it('truncates a chunk that crosses the cell cap instead of retaining all of it', () => {
    // Only the accepted prefix is INDEXED: a one-shot 10-point chunk with
    // a 3-cell budget must count and bound exactly 3 points. That the
    // prefix is also the only thing RETAINED — the half of the claim that
    // makes the cap bound memory rather than bookkeeping — is not visible
    // here (`pointCount` and `getBounds` read the same either way) and is
    // pinned separately in "what the index retains of the caller's
    // buffers" below.
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 3);
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) pts.push(i, 0, 0);
    idx.insertRange(new Float32Array(pts), 10);
    assert.strictEqual(idx.pointCount, 3);
    // Point ids stay contiguous with the truncated count, so a later
    // chunk's ids cannot collide with the dropped tail.
    const b = idx.getBounds();
    assert.ok(b);
    assert.strictEqual(b!.max.x, 2);
  });

  it('reports "points" when the point cap binds first (dense cloud)', () => {
    const idx = new PointCloudSpatialIndex(0.5, 3, 1_000_000);
    idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4]), 4);
    assert.strictEqual(idx.pointCount, 3);
    assert.strictEqual(idx.capReason, 'points');
  });

  it('clamps a caller-supplied cell cap below the engine ceiling', () => {
    // A caller asking for more cells than V8 can hold must still get a
    // bounded grid — the clamp is what makes the guarantee unconditional.
    const huge = new PointCloudSpatialIndex(0.5, 10, Number.MAX_SAFE_INTEGER);
    assert.ok(
      huge.cellCapacity < V8_MAP_MAX_ENTRIES,
      `effective cell budget ${huge.cellCapacity} must stay under the engine ceiling`,
    );
    assert.strictEqual(huge.cellCapacity, V8_MAP_MAX_ENTRIES - 1);
    huge.insertRange(new Float32Array([0, 0, 1]), 1);
    assert.strictEqual(huge.pointCount, 1);
    assert.strictEqual(huge.isCapped, false);

    // An invalid budget falls back to the default, which is itself under
    // the ceiling — never to "unbounded".
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const idx = new PointCloudSpatialIndex(0.5, 10, bad);
      assert.strictEqual(idx.cellCapacity, DEFAULT_MAX_INDEXED_CELLS, `budget ${bad}`);
      assert.ok(idx.cellCapacity < V8_MAP_MAX_ENTRIES);
    }
  });

  it('pins the cell size the sparse worst case is derived from', () => {
    // The 1:1 cells-per-point worst case assumed above is a property of
    // the cell size: at 0.5 m, airborne LiDAR (1-20 pts/m^2) puts on the
    // order of one point in each cell.
    assert.strictEqual(DEFAULT_POINTCLOUD_INDEX_CELL_SIZE, 0.5);
  });

  it('announces the truncation exactly once, naming the limb that bound', () => {
    // A silently truncated index is indistinguishable from a broken measure
    // tool, so the outcome is reported rather than swallowed — but only
    // once per index, not once per streamed chunk.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 2);
      idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 9, 0, 0, 20]), 3);
      idx.insertRange(new Float32Array([0, 0, 30]), 1);
      idx.insertRange(new Float32Array([0, 0, 40]), 1);
    } finally {
      console.warn = original;
    }
    assert.strictEqual(warnings.length, 1, 'exactly one report per index, not one per chunk');
    assert.ok(warnings[0].includes('PointCloudSpatialIndex'));
    assert.ok(warnings[0].includes('cells limit'), warnings[0]);
  });

  it('clears the cap state on dispose so a reused index indexes again', () => {
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 1);
    idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 9]), 2);
    assert.strictEqual(idx.capReason, 'cells');
    idx.dispose();
    assert.strictEqual(idx.capReason, null);
    assert.strictEqual(idx.isCapped, false);
    assert.strictEqual(idx.cellCount, 0);
    idx.insertRange(new Float32Array([0, 0, 1]), 1);
    assert.strictEqual(idx.pointCount, 1);
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

describe('PointCloudSpatialIndex — georeferenced (huge-coordinate) clouds', () => {
  // Un-rebased LV95-style coordinates: easting ~2.6e6 m, northing (Y-up
  // swapped to -Z) ~-1.2e6 m. Cell keys are packed relative to the first
  // indexed point's cell, so they must stay exact and collision-free at
  // this magnitude — the pre-fix absolute packing overflowed f64's 53-bit
  // integer range out here. All values chosen below are exactly
  // representable in f32 (integers and halves < 2^24), so assertions can
  // be exact.
  const E = 2_600_000;
  const N = -1_200_000;

  it('finds the nearest of two points 1m apart at LV95 magnitude', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([E + 10, 400, N, E + 11, 400, N]), 2);
    const hit = idx.queryRay({ x: E, y: 400, z: N }, { x: 1, y: 0, z: 0 }, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 10);
    assert.strictEqual(hit!.position.x, E + 10);
    assert.strictEqual(hit!.position.z, N);
  });

  it('still rejects an out-of-tolerance point at LV95 magnitude', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([E + 10, 400.25, N]), 1); // 0.25m off-axis
    assert.strictEqual(
      idx.queryRay({ x: E, y: 400, z: N }, { x: 1, y: 0, z: 0 }, 100, flatTolerance(0.05)),
      null,
    );
  });

  it('a clamped boundary mega-bucket can never produce a false-positive hit', () => {
    // Beyond the ±2^16-cell window, insert clamps points onto boundary
    // cells, merging distinct cells into one bucket. That must degrade
    // PERFORMANCE only — never correctness: every candidate is re-checked
    // against its real position (`testPoint`), so a bucket-mate that is
    // out of reach (or out of tolerance) must not be returned. Here the
    // ray's marched cells and the 50km-away point share the clamped
    // boundary bucket, but the point is 9.9km past maxDistance.
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 0, 50_000, 0, 0]), 2);
    assert.strictEqual(
      idx.queryRay({ x: 40_000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 100, flatTolerance(0.05)),
      null,
      'an out-of-reach point sharing a clamped bucket must not be returned',
    );
    // Same bucket-merge, point 5m off-axis vs 0.05m tolerance: rejected.
    assert.strictEqual(
      idx.queryRay({ x: 49_990, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 1000, flatTolerance(0.05)),
      null,
      'an out-of-tolerance point sharing a clamped bucket must not be returned',
    );
  });

  it('a point beyond the ±32.7km relative-key window is clamped, not lost', () => {
    // First point pins the cell origin near 0; the second sits 50km away,
    // outside the packable relative window. Its cells clamp onto the
    // window boundary — buckets merge there, but insert and query clamp
    // identically, so the point must still be found exactly.
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 0, 50_000, 0, 0]), 2);
    const hit = idx.queryRay({ x: 49_990, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 100, flatTolerance(0.05));
    assert.ok(hit, 'point past the relative-key window must remain queryable via boundary clamping');
    assert.strictEqual(hit!.distance, 10);
    assert.strictEqual(hit!.position.x, 50_000);
  });
});

describe('PointCloudSpatialIndex — streaming arrival (#1860)', () => {
  it('a query after a later chunk arrives sees the new points (no stale-subset snapshot)', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 20]), 1);
    // Query while only the far point is streamed in.
    let hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 20);
    // A later chunk streams in a NEARER point; the very next query must
    // prefer it — the index is live, not a build-once snapshot.
    idx.insertRange(new Float32Array([0, 0, 4]), 1);
    hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 4);
  });

  it('dense cluster: many in-tolerance candidates resolve to the frontmost point', () => {
    // 300 points jittered inside the tolerance cylinder between z=5.0
    // and z=5.6 — a dense-scan cursor position. The chosen point must be
    // the one nearest along the ray (the visible/occluding one), not an
    // arbitrary bucket order artifact.
    const pts: number[] = [];
    for (let i = 0; i < 300; i++) {
      const off = ((i % 7) - 3) * 0.01; // ±0.03m off-axis, inside 0.05 tolerance
      pts.push(off, 0, 5.0 + (i / 299) * 0.6);
    }
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array(pts), 300);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.ok(Math.abs(hit!.distance - 5.0) < 1e-6, `expected frontmost ~5.0, got ${hit!.distance}`);
  });
});

describe('PointCloudSpatialIndex — LAS class visibility mask (#1783 interplay)', () => {
  // Mask helper: 8 words, all classes visible except the listed ones.
  const maskHiding = (...hidden: number[]): Uint32Array => {
    const m = new Uint32Array(8).fill(0xffffffff);
    for (const c of hidden) m[c >> 5] &= ~(1 << (c & 31));
    return m;
  };

  it('skips points whose class the splat shader currently hides', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    // Near point is class 2 (e.g. ground), far point class 6 (building).
    idx.insertRange(new Float32Array([0, 0, 5, 0, 0, 9]), 2, new Uint8Array([2, 6]));

    // Everything visible: nearest (class 2, z=5) wins.
    let hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), maskHiding());
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 5);

    // Class 2 hidden: the measure tool must NOT snap to the invisible
    // near point; the visible class-6 point behind it wins instead.
    hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), maskHiding(2));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 9);

    // Both classes hidden: nothing snappable.
    assert.strictEqual(
      idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), maskHiding(2, 6)),
      null,
    );
  });

  it('classification-free chunks behave as class 0, mirroring the GPU vertex packing', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5]), 1); // no classifications buffer
    assert.ok(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), maskHiding(1)));
    // Hiding class 0 hides unclassified points — exactly what the shader does.
    assert.strictEqual(
      idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), maskHiding(0)),
      null,
    );
  });

  it('no mask (undefined/null) means everything is snappable', () => {
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(new Float32Array([0, 0, 5]), 1, new Uint8Array([7]));
    assert.ok(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05)));
    assert.ok(idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), null));
  });

  it('classifications survive a cap-crossing chunk in step with positions', () => {
    // Chunk of 4 crosses a cap of 2: only the retained prefix is indexed
    // AND its classes stay aligned (a mismatch would mask the wrong points).
    const idx = new PointCloudSpatialIndex(0.5, 2);
    idx.insertRange(
      new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4]),
      4,
      new Uint8Array([9, 1, 1, 1]),
    );
    assert.strictEqual(idx.pointCount, 2);
    // Hiding class 9 hides the first (z=1) point → z=2 wins.
    const m = new Uint32Array(8).fill(0xffffffff);
    m[0] &= ~(1 << 9);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), m);
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 2);
  });
});

describe("PointCloudSpatialIndex — what the index retains of the caller's buffers", () => {
  // `insertRange`'s contract has two halves, and BOTH are memory claims
  // rather than picking claims: a chunk that fits is kept BY REFERENCE
  // (copying it would double the 12 bytes/point this index already
  // costs), and a chunk that CROSSES a cap keeps only a COPY of the
  // accepted prefix (keeping the whole array by reference would retain a
  // 100M-point chunk's 1.2 GB behind a 30M-point cap, so the cap would
  // bound bookkeeping and not memory).
  //
  // Neither half is visible through `pointCount`, `cellCount` or
  // `getBounds` — all three are folded in at insert time and read the
  // same whichever array the chunk ended up holding. The only handle on
  // "which array" is what `queryRay` reads back, so these tests write to
  // the caller's array after the insert and watch whether the change
  // shows through.
  //
  // Writing to it is exactly what the class doc tells callers NOT to do.
  // That is deliberate and is not an endorsement: the mutation is the
  // instrument, the way a spy is, and what is asserted is which storage
  // the index kept — not that mutating afterwards is supported. The
  // alternative is a documented memory bound that nothing enforces.
  // The mechanism relied on is fully specified rather than incidental:
  // `TypedArray.prototype.slice` allocates a new buffer, while the array
  // passed in stays a live view over the caller's buffer.

  it('keeps only a copy of the accepted prefix when a chunk crosses the cell cap', () => {
    // 10 points, one per 0.5 m cell, against a 3-cell budget: the chunk
    // is truncated to 3 and the other 7 triples must not be retained.
    const src = new Float32Array(30);
    for (let i = 0; i < 10; i++) src[i * 3 + 2] = 1 + i;
    const idx = new PointCloudSpatialIndex(0.5, 1_000_000, 3);
    idx.insertRange(src, 10);
    assert.strictEqual(idx.pointCount, 3, 'precondition: the chunk was truncated');

    const before = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(before);
    assert.strictEqual(before!.distance, 1);

    // Overwrite the caller's array wholesale. A retained COPY is a
    // different buffer and cannot see this; a retained REFERENCE would
    // put every indexed point 999 m down the ray, i.e. out of range.
    src.fill(999);

    const after = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(after, "a truncated chunk must be copied, not aliased to the caller's array");
    assert.strictEqual(after!.distance, 1);
    assert.strictEqual(after!.position.z, 1);
  });

  it('keeps only a copy of the accepted classifications when a chunk crosses a cap', () => {
    // Same claim for the parallel class array — it is sliced on the same
    // branch, and a retained reference would let a later write change
    // which points the LAS visibility mask hides.
    const classes = new Uint8Array([1, 1, 1, 1]);
    const idx = new PointCloudSpatialIndex(0.5, 2);
    idx.insertRange(new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4]), 4, classes);
    assert.strictEqual(idx.pointCount, 2, 'precondition: the chunk was truncated');

    classes.fill(9);

    // Class 9 hidden, class 1 visible. A copy still reports both indexed
    // points as class 1, so the nearest (z=1) wins; a retained reference
    // would see class 9 everywhere and hide the whole chunk.
    const mask = new Uint32Array(8).fill(0xffffffff);
    mask[0] &= ~(1 << 9);
    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05), mask);
    assert.ok(hit, 'truncated classifications must be copied, not aliased');
    assert.strictEqual(hit!.distance, 1);
  });

  it('keeps a chunk that fits BY REFERENCE, paying no copy', () => {
    // The other direction, and the reason the copy above is confined to
    // the truncating branch: the streaming path inserts whole chunks that
    // fit, and copying each one would double this index's retained bytes
    // per point. A copy-always implementation would pass the two tests
    // above and fail this one.
    const src = new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3]);
    const idx = new PointCloudSpatialIndex(0.5);
    idx.insertRange(src, 3);
    assert.strictEqual(idx.pointCount, 3, 'precondition: nothing was truncated');

    // Nudge the nearest point within its own 0.5 m cell, so the write
    // changes only the position read back and not the grid the query
    // walks. Reading it back through `queryRay` == the array was not copied.
    src[2] = 1.25;

    const hit = idx.queryRay(FORWARD_RAY.origin, FORWARD_RAY.direction, 100, flatTolerance(0.05));
    assert.ok(hit);
    assert.strictEqual(hit!.distance, 1.25, 'a chunk that fits must be aliased, not copied');
  });
});
