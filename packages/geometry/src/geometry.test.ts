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
  });
});
