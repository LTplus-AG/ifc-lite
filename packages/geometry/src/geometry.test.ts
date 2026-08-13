/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry Package Unit Tests
 *
 * Tests pure utility functions that don't require WASM.
 * Focus on contract/behavior testing, not implementation details.
 */

import { describe, it, beforeEach, expect } from 'vitest';

import { BufferBuilder } from './buffer-builder.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';

// Helper to create test mesh data
function createTestMesh(overrides: Partial<MeshData> & { expressId: number }): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1] as [number, number, number, number],
    ...overrides,
  };
}

describe('BufferBuilder', () => {
  let builder: BufferBuilder;

  beforeEach(() => {
    builder = new BufferBuilder();
  });

  describe('buildInterleavedBuffer', () => {
    it('should create interleaved position+normal buffer', () => {
      const mesh = createTestMesh({ expressId: 1 });
      const buffer = builder.buildInterleavedBuffer(mesh);

      // 3 vertices × 6 floats each (pos + normal)
      expect(buffer.length).toBe(18);

      // First vertex: position (0,0,0) then normal (0,0,1)
      expect(buffer[0]).toBe(0); // x
      expect(buffer[1]).toBe(0); // y
      expect(buffer[2]).toBe(0); // z
      expect(buffer[3]).toBe(0); // nx
      expect(buffer[4]).toBe(0); // ny
      expect(buffer[5]).toBe(1); // nz
    });

    it('should preserve all vertex data', () => {
      const mesh = createTestMesh({
        expressId: 1,
        positions: new Float32Array([1, 2, 3, 4, 5, 6]),
        normals: new Float32Array([0.5, 0.5, 0, 0, 1, 0]),
      });

      const buffer = builder.buildInterleavedBuffer(mesh);

      // 2 vertices × 6 floats
      expect(buffer.length).toBe(12);

      // Vertex 1
      expect(buffer[0]).toBe(1);
      expect(buffer[1]).toBe(2);
      expect(buffer[2]).toBe(3);
      expect(buffer[3]).toBe(0.5);
      expect(buffer[4]).toBe(0.5);
      expect(buffer[5]).toBe(0);

      // Vertex 2
      expect(buffer[6]).toBe(4);
      expect(buffer[7]).toBe(5);
      expect(buffer[8]).toBe(6);
      expect(buffer[9]).toBe(0);
      expect(buffer[10]).toBe(1);
      expect(buffer[11]).toBe(0);
    });
  });

  describe('processMeshes', () => {
    it('should calculate correct totals', () => {
      const meshes = [
        createTestMesh({ expressId: 1 }), // 3 vertices, 1 triangle
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), // 4 normals to match 4 vertices
          indices: new Uint32Array([0, 1, 2, 1, 2, 3]),
        }), // 4 vertices, 2 triangles
      ];

      const result = builder.processMeshes(meshes);

      expect(result.totalVertices).toBe(7);
      expect(result.totalTriangles).toBe(3);
      expect(result.meshes.length).toBe(2);
    });

    it('should handle empty mesh array', () => {
      const result = builder.processMeshes([]);

      expect(result.totalVertices).toBe(0);
      expect(result.totalTriangles).toBe(0);
      expect(result.meshes.length).toBe(0);
    });
  });
});

describe('CoordinateHandler', () => {
  let handler: CoordinateHandler;

  beforeEach(() => {
    handler = new CoordinateHandler();
  });

  describe('calculateBounds', () => {
    it('should calculate correct bounding box', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 5, 3]),
        }),
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([-5, -10, -2, 20, 15, 8]),
        }),
      ];

      const bounds = handler.calculateBounds(meshes);

      expect(bounds.min.x).toBe(-5);
      expect(bounds.min.y).toBe(-10);
      expect(bounds.min.z).toBe(-2);
      expect(bounds.max.x).toBe(20);
      expect(bounds.max.y).toBe(15);
      expect(bounds.max.z).toBe(8);
    });

    it('should filter out corrupted values', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1e8, 1e8, 1e8, 10, 10, 10]), // middle vertex corrupted
        }),
      ];

      const bounds = handler.calculateBounds(meshes);

      // Corrupted vertex (1e8 > 1e7 threshold) should be excluded
      expect(bounds.max.x).toBe(10);
      expect(bounds.max.y).toBe(10);
      expect(bounds.max.z).toBe(10);
    });

    // Every other bounds fixture leaves `origin` absent, so the per-element
    // local-frame fold (`world = origin + position`) is exercised by nothing:
    // dropping `+ ox/oy/oz` leaves them all green. Without the fold, a model
    // whose elements each carry their own origin collapses to a box around
    // zero and the viewer fits the camera on the wrong volume.
    it('folds each mesh origin into world bounds', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 2, 3]),
          origin: [100, 200, 300],
        }),
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
          origin: [-40, -50, -60],
        }),
      ];

      const bounds = handler.calculateBounds(meshes);

      expect(bounds.min).toEqual({ x: -40, y: -50, z: -60 });
      expect(bounds.max).toEqual({ x: 101, y: 202, z: 303 });
    });

    // Distinct per-axis origins: an implementation that folded ox into all
    // three axes (or reused one component) still passes an isotropic fixture.
    it('applies the origin components axis-by-axis', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0]),
          origin: [7, 11, 13],
        }),
      ];

      const bounds = handler.calculateBounds(meshes);

      expect(bounds.min).toEqual({ x: 7, y: 11, z: 13 });
      expect(bounds.max).toEqual({ x: 7, y: 11, z: 13 });
    });
  });

  describe('shiftPositions', () => {
    it('subtracts the shift per axis', () => {
      const positions = new Float32Array([10, 20, 30, 40, 50, 60]);

      handler.shiftPositions(positions, { x: 1, y: 2, z: 3 });

      expect(Array.from(positions)).toEqual([9, 18, 27, 39, 48, 57]);
    });

    // The corrupted-vertex clamp: deleting the whole `else` branch (leaving
    // garbage in place) passed the suite. A NaN or 1e30 vertex reaching the GPU
    // buffer explodes the mesh's bounding box and can blank the whole model.
    it('clamps non-finite and out-of-range vertices to the shifted origin', () => {
      const positions = new Float32Array([
        1, 2, 3, // valid
        NaN, 0, 0, // non-finite
        1e8, 1e8, 1e8, // beyond MAX_REASONABLE_COORD
      ]);

      handler.shiftPositions(positions, { x: 1, y: 1, z: 1 });

      expect(Array.from(positions.subarray(0, 3))).toEqual([0, 1, 2]);
      expect(Array.from(positions.subarray(3, 6))).toEqual([0, 0, 0]);
      expect(Array.from(positions.subarray(6, 9))).toEqual([0, 0, 0]);
    });

    it('honours an explicit tighter threshold', () => {
      const positions = new Float32Array([50000, 0, 0]);

      handler.shiftPositions(positions, { x: 0, y: 0, z: 0 }, 10000);

      expect(Array.from(positions)).toEqual([0, 0, 0]);
    });
  });

  describe('needsShift', () => {
    it('should return false for small coordinates', () => {
      const bounds = {
        min: { x: -100, y: -100, z: -10 },
        max: { x: 100, y: 100, z: 50 },
      };

      expect(handler.needsShift(bounds)).toBe(false);
    });

    it('should return true for large coordinates (>10km)', () => {
      const bounds = {
        min: { x: 500000, y: 5000000, z: 0 },
        max: { x: 500100, y: 5000100, z: 50 },
      };

      expect(handler.needsShift(bounds)).toBe(true);
    });

    it('pins the AT-threshold boundary: exactly 10km is NOT a shift, one unit over IS', () => {
      // THRESHOLD is 10000 (metres) and the comparison is strict `>`. Every
      // existing fixture sits either far below (100) or far above (500000+)
      // that line, so a `>` → `>=` mutation at the boundary was invisible to
      // the whole suite. Pin both sides of the exact threshold so that
      // regressing the operator (either direction) is caught here.
      const atThreshold = {
        min: { x: -10000, y: 0, z: 0 },
        max: { x: 10000, y: 0, z: 0 },
      };
      expect(handler.needsShift(atThreshold)).toBe(false);

      const justOverThreshold = {
        min: { x: -10000, y: 0, z: 0 },
        max: { x: 10000.001, y: 0, z: 0 },
      };
      expect(handler.needsShift(justOverThreshold)).toBe(true);
    });

    // The comparison is strictly `>`; both existing cases sit far from the
    // 10 km threshold, so `>` vs `>=` was indistinguishable.
    it('treats exactly the 10km threshold as not needing a shift', () => {
      expect(
        handler.needsShift({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 10000, y: 0, z: 0 },
        })
      ).toBe(false);

      expect(
        handler.needsShift({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 10000.5, y: 0, z: 0 },
        })
      ).toBe(true);
    });

    it('considers the most negative extent, not just the maxima', () => {
      expect(
        handler.needsShift({
          min: { x: 0, y: -50000, z: 0 },
          max: { x: 1, y: 1, z: 1 },
        })
      ).toBe(true);
    });
  });

  describe('processMeshes', () => {
    it('should not shift small coordinate models', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 10, 10]),
        }),
      ];

      const info = handler.processMeshes(meshes);

      expect(info.hasLargeCoordinates).toBe(false);
      expect(info.originShift.x).toBe(0);
      expect(info.originShift.y).toBe(0);
      expect(info.originShift.z).toBe(0);
    });

    it('should shift large coordinate models to origin', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ];

      const originalPositions = new Float32Array(meshes[0].positions);
      const info = handler.processMeshes(meshes);

      expect(info.hasLargeCoordinates).toBe(true);

      // Shift should be approximately the centroid
      expect(Math.abs(info.originShift.x - 500050)).toBeLessThan(1);
      expect(Math.abs(info.originShift.y - 5000050)).toBeLessThan(1);

      // Positions should be shifted (mutated in-place)
      expect(Math.abs(meshes[0].positions[0])).toBeLessThan(100);
      expect(Math.abs(meshes[0].positions[1])).toBeLessThan(100);
    });

    it('should handle empty mesh array', () => {
      const info = handler.processMeshes([]);

      expect(info.hasLargeCoordinates).toBe(false);
      expect(info.originShift.x).toBe(0);
    });

    // The no-shift branch still runs a zero-shift pass purely to scrub
    // corrupted vertices. Nothing asserted that, so removing the scrub — the
    // only thing that branch does — stayed green.
    it('scrubs corrupted vertices even when no shift is needed', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([1, 2, 3, NaN, 5, 6, 1e9, 0, 0]),
        }),
      ];

      const info = handler.processMeshes(meshes);

      expect(info.hasLargeCoordinates).toBe(false);
      // Valid vertex untouched (zero shift), corrupted ones collapsed to 0.
      expect(Array.from(meshes[0].positions)).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe('coordinate conversion', () => {
    it('should round-trip local to world and back', () => {
      const meshes = [
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ];

      handler.processMeshes(meshes);

      const localPoint = { x: 10, y: 20, z: 5 };
      const worldPoint = handler.toWorldCoordinates(localPoint);
      const backToLocal = handler.toLocalCoordinates(worldPoint);

      expect(Math.abs(backToLocal.x - localPoint.x)).toBeLessThan(0.001);
      expect(Math.abs(backToLocal.y - localPoint.y)).toBeLessThan(0.001);
      expect(Math.abs(backToLocal.z - localPoint.z)).toBeLessThan(0.001);
    });
  });

  describe('incremental processing', () => {
    it('should accumulate bounds across batches', () => {
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 10, 10]),
        }),
      ]);

      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([-5, -5, -5, 20, 20, 20]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();

      expect(info.originalBounds.min.x).toBe(-5);
      expect(info.originalBounds.max.x).toBe(20);
    });

    it('pins the AT-50%-boundary of the WASM-RTC-already-applied heuristic', () => {
      // processMeshesIncremental infers "WASM already applied RTC" when a
      // STRICT MAJORITY (`> 0.5`, not `>=`) of a batch's meshes have a small
      // first vertex. Every existing incremental fixture is either all-small
      // (ratio 1) or (via processTrustedMeshesIncremental) skips the
      // heuristic entirely, so a `>` → `>=` mutation at exactly 0.5 was
      // invisible, and so was neutering the heuristic altogether (forcing it
      // to `false` also left the whole suite green).
      //
      // One small mesh + one genuinely large one is a 50/50 split: `0.5 > 0.5`
      // is false, so the heuristic must NOT treat this batch as pre-shifted,
      // and the real >10km bounds must trigger an actual shift.
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        }),
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.hasLargeCoordinates).toBe(true);
      expect(info.originShift.x).not.toBe(0);
      expect(info.originShift.y).not.toBe(0);
    });

    it('does not shift a batch WASM already RTC-shifted (heuristic true side)', () => {
      // The 50/50 test above pins the boundary but NOT the heuristic firing:
      // at exactly 0.5 the real expression and a hardcoded `false` agree, so
      // neutering the heuristic entirely still passed it. The `true` side is
      // what carries the safety property — `!wasmRtcLikelyApplied` gates
      // whether `originShift` is set at all, so a heuristic stuck at `false`
      // shifts a model WASM has ALREADY shifted, moving it twice.
      //
      // Two small meshes + one large one is a strict majority (2/3 > 0.5), so
      // the heuristic must fire even though the accumulated bounds still span
      // past 10 km and would otherwise trigger a shift.
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        }),
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([2, 2, 2, 3, 3, 3]),
        }),
        createTestMesh({
          expressId: 3,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.originShift.x).toBe(0);
      expect(info.originShift.y).toBe(0);
      expect(info.originShift.z).toBe(0);

      // Fixture guard, and the whole point of the test: that same large mesh
      // ALONE (ratio 0/1, heuristic false) must produce a real shift. Without
      // this the assertions above are vacuous — a batch that never qualified
      // for a shift has a zero originShift no matter what the heuristic does.
      // Asserting the counterfactual here is what attributes the difference
      // to the heuristic rather than to the fixture.
      const control = new CoordinateHandler();
      control.processMeshesIncremental([
        createTestMesh({
          expressId: 3,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ]);
      const controlInfo = control.getFinalCoordinateInfo();
      expect(controlInfo.originShift.y).not.toBe(0);
    });

    it('should reset state for new file', () => {
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 10, 10]),
        }),
      ]);

      handler.reset();

      const info = handler.getCurrentCoordinateInfo();
      expect(info).toBeNull();
    });

    it('should accumulate trusted native bounds without applying a shift', () => {
      handler.processTrustedMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([100, 200, 300, 110, 210, 310]),
        }),
      ]);

      handler.processTrustedMeshesIncremental([
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([-20, -10, 5, 40, 50, 60]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();

      expect(info.hasLargeCoordinates).toBe(false);
      expect(info.originShift).toEqual({ x: 0, y: 0, z: 0 });
      expect(info.originalBounds.min.x).toBe(-20);
      expect(info.originalBounds.max.z).toBe(310);
    });

    // The trusted path resets `originShift` to zero. Every existing trusted
    // test starts from a fresh handler where the shift is ALREADY zero, so the
    // reset was a no-op in the fixture and deleting the line stayed green.
    // In production the trusted path can follow a shifted browser batch.
    it('clears a shift established by an earlier non-trusted batch', () => {
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([500000, 5000000, 100, 500100, 5000100, 150]),
        }),
      ]);
      // Precondition: the browser path did establish a non-zero shift.
      expect(handler.getOriginShift()).not.toEqual({ x: 0, y: 0, z: 0 });

      handler.processTrustedMeshesIncremental([
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([1, 2, 3, 4, 5, 6]),
        }),
      ]);

      expect(handler.getOriginShift()).toEqual({ x: 0, y: 0, z: 0 });
      expect(handler.getFinalCoordinateInfo().hasLargeCoordinates).toBe(false);
    });

    // The shift trigger is `distanceFromOrigin > 10km OR maxSize > 10km`.
    // Every fixture was far from the origin, so the extent half of the OR was
    // dead weight: a 40km-wide site straddling the origin never got shifted
    // and keeps float precision loss across the whole model.
    it('shifts a model that straddles the origin but spans more than 10km', () => {
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([-20000, -20000, 0, 21000, 21000, 10]),
        }),
      ]);

      const shift = handler.getOriginShift();
      expect(shift.x).toBeCloseTo(500, 6);
      expect(shift.y).toBeCloseTo(500, 6);
      expect(handler.getFinalCoordinateInfo().hasLargeCoordinates).toBe(true);
    });

    // WASM-RTC detection is "> 50% of meshes have a small first vertex".
    // A 1-of-2 batch sits exactly ON the boundary: `>` must NOT fire, so the
    // shift is still applied. `>=` there would silently suppress the shift.
    it('does not claim WASM RTC on an exact 50/50 split', () => {
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]), // small first vertex
        }),
        createTestMesh({
          expressId: 2,
          positions: new Float32Array([500000, 5000000, 0, 500010, 5000010, 5]),
        }),
      ]);

      expect(handler.getOriginShift()).not.toEqual({ x: 0, y: 0, z: 0 });
      expect(handler.getFinalCoordinateInfo().hasLargeCoordinates).toBe(true);
    });

    it('claims WASM RTC once a clear majority of meshes are small, and skips the shift', () => {
      handler.processMeshesIncremental([
        createTestMesh({ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 1, 1]) }),
        createTestMesh({ expressId: 2, positions: new Float32Array([2, 2, 2, 3, 3, 3]) }),
        createTestMesh({
          expressId: 3,
          positions: new Float32Array([500000, 5000000, 0, 500010, 5000010, 5]),
        }),
      ]);

      expect(handler.getOriginShift()).toEqual({ x: 0, y: 0, z: 0 });
      // Bounds are recomputed at the 10km threshold, dropping the outlier.
      expect(handler.getFinalCoordinateInfo().originalBounds.max.x).toBe(3);
    });

    // Once RTC is confirmed, later batches deliberately take the SAMPLED
    // bounds path (first + last vertex only) — a documented ~150x speedup.
    // Nothing pinned it, so replacing the guard with a full per-vertex scan
    // stayed green while costing that speedup.
    it('samples first and last vertex only once WASM RTC is confirmed', () => {
      handler.processMeshesIncremental([
        createTestMesh({ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 1, 1]) }),
      ]);

      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 2,
          // Interior vertex is the extreme one; the sampled path must miss it.
          positions: new Float32Array([2, 0, 0, 900, 0, 0, 4, 0, 0]),
        }),
      ]);

      expect(handler.getFinalCoordinateInfo().originalBounds.max.x).toBe(4);
    });
  });

  describe('trusted (native) bounds sampling', () => {
    // calculateBoundsFast folds each mesh origin too; every trusted fixture
    // left `origin` absent, so dropping the fold there was also invisible.
    it('folds each mesh origin into the sampled bounds', () => {
      handler.processTrustedMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 2, 3]),
          origin: [1000, 2000, 3000],
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.originalBounds.min).toEqual({ x: 1000, y: 2000, z: 3000 });
      expect(info.originalBounds.max).toEqual({ x: 1001, y: 2002, z: 3003 });
    });

    it('skips meshes with fewer than three position components', () => {
      handler.processTrustedMeshesIncremental([
        createTestMesh({ expressId: 1, positions: new Float32Array([]) }),
        createTestMesh({ expressId: 2, positions: new Float32Array([5, 6, 7]) }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.originalBounds.min).toEqual({ x: 5, y: 6, z: 7 });
    });

    it('returns no info when a batch yields no valid bounds', () => {
      handler.processTrustedMeshesIncremental([
        createTestMesh({ expressId: 1, positions: new Float32Array([]) }),
      ]);

      expect(handler.getCurrentCoordinateInfo()).toBeNull();
    });
  });

  describe('wasm metadata (#945)', () => {
    it('surfaces lengthUnitScale and the applied wasmRtcOffset', () => {
      handler.setWasmMetadata(0.001, { x: -10215.88, y: 2007.82, z: 164.95 });
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 10, 10]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.lengthUnitScale).toBe(0.001);
      expect(info.wasmRtcOffset).toEqual({ x: -10215.88, y: 2007.82, z: 164.95 });
    });

    it('omits wasmRtcOffset when no shift was applied but keeps lengthUnitScale', () => {
      handler.setWasmMetadata(1, null);
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.lengthUnitScale).toBe(1);
      expect(info.wasmRtcOffset).toBeUndefined();
    });

    it('surfaces the metadata on the batch processMeshes path too (#2526)', () => {
      // The sync GeometryProcessor.process() path goes through processMeshes,
      // not processMeshesIncremental + getFinalCoordinateInfo. Dropping the
      // rtc offset there makes every downstream georef consumer read the
      // rebased bounds as if they were absolute — the map-conversion math
      // then loses the re-based site offset (height AND position).
      handler.setWasmMetadata(0.001, { x: 312018.898, y: 5996169.654, z: 14 });
      const info = handler.processMeshes([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 10, 10, 10]),
        }),
      ]);

      expect(info.lengthUnitScale).toBe(0.001);
      expect(info.wasmRtcOffset).toEqual({ x: 312018.898, y: 5996169.654, z: 14 });
    });

    it('keeps lengthUnitScale on the processMeshes large-coordinate shift branch', () => {
      // No wasm RTC (offset null) but a known unit scale; the TS-side shift
      // kicks in for >10km coordinates and must not drop the metadata.
      handler.setWasmMetadata(0.001, null);
      const info = handler.processMeshes([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([20000, 20000, 0, 20010, 20010, 10]),
        }),
      ]);

      expect(info.hasLargeCoordinates).toBe(true);
      expect(info.lengthUnitScale).toBe(0.001);
      expect(info.wasmRtcOffset).toBeUndefined();
    });

    it('clears metadata on reset', () => {
      handler.setWasmMetadata(0.001, { x: 1, y: 2, z: 3 });
      handler.reset();
      handler.processMeshesIncremental([
        createTestMesh({
          expressId: 1,
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        }),
      ]);

      const info = handler.getFinalCoordinateInfo();
      expect(info.lengthUnitScale).toBeUndefined();
      expect(info.wasmRtcOffset).toBeUndefined();
    });
  });
});
