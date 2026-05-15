/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { GLTFExporter } from './gltf-exporter.js';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';

// Helper to create a minimal mesh for testing
function createTestMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), // Triangle
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.5, 0.5, 1.0] as [number, number, number, number],
  };
}

// Helper to create a minimal GeometryResult
function createTestGeometryResult(meshCount: number = 1): GeometryResult {
  const meshes = Array.from({ length: meshCount }, (_, i) => createTestMesh(i + 1));
  const totalVertices = meshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
  const totalTriangles = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);

  return {
    meshes,
    totalVertices,
    totalTriangles,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      hasLargeCoordinates: false,
    },
  };
}

describe('GLTFExporter', () => {
  it('should export valid GLB binary', () => {
    const geometryResult = createTestGeometryResult(1);
    const exporter = new GLTFExporter(geometryResult);

    const glb = exporter.exportGLB();

    // GLB magic header is "glTF" (0x46546C67)
    const magic = new DataView(glb.buffer).getUint32(0, true);
    expect(magic).toBe(0x46546C67);

    // GLB version should be 2
    const version = new DataView(glb.buffer).getUint32(4, true);
    expect(version).toBe(2);
  });

  it('should export valid glTF JSON', () => {
    const geometryResult = createTestGeometryResult(1);
    const exporter = new GLTFExporter(geometryResult);

    const { json } = exporter.exportGLTF();
    const gltf = JSON.parse(json);

    // Check required glTF properties
    expect(gltf.asset).toBeTruthy();
    expect(gltf.asset.version).toBe('2.0');
    expect(Array.isArray(gltf.scenes)).toBe(true);
    expect(Array.isArray(gltf.nodes)).toBe(true);
    expect(Array.isArray(gltf.meshes)).toBe(true);
  });

  it('should include metadata when option is enabled', () => {
    const geometryResult = createTestGeometryResult(2);
    const exporter = new GLTFExporter(geometryResult);

    const { json } = exporter.exportGLTF({ includeMetadata: true });
    const gltf = JSON.parse(json);

    // Check metadata in asset extras
    expect(gltf.asset.extras).toBeTruthy();
    expect(gltf.asset.extras.meshCount).toBe(2);
  });

  it('should handle multiple meshes', () => {
    const meshCount = 5;
    const geometryResult = createTestGeometryResult(meshCount);
    const exporter = new GLTFExporter(geometryResult);

    const { json } = exporter.exportGLTF();
    const gltf = JSON.parse(json);

    // Each mesh should create a node
    expect(gltf.nodes.length).toBe(meshCount);
  });

  // Roundtrip validation tests
  describe('roundtrip validation', () => {
    it('should export GLB with valid header length', () => {
      const geometryResult = createTestGeometryResult(3);
      const exporter = new GLTFExporter(geometryResult);

      const glb = exporter.exportGLB();

      // Parse GLB header
      const view = new DataView(glb.buffer);
      const totalLength = view.getUint32(8, true);

      // GLB should have reasonable size
      expect(glb.byteLength).toBe(totalLength);
      expect(glb.byteLength).toBeGreaterThan(100);
    });

    it('should create valid accessor for positions', () => {
      const geometryResult = createTestGeometryResult(1);
      const exporter = new GLTFExporter(geometryResult);

      const { json } = exporter.exportGLTF();
      const gltf = JSON.parse(json);

      // Check position accessor
      const posAccessor = gltf.accessors?.find((a: any) => a.type === 'VEC3');
      expect(posAccessor).toBeTruthy();
      expect(posAccessor.componentType).toBe(5126); // Position should be FLOAT (5126)
      expect(posAccessor.count).toBe(3); // Should have 3 vertices
    });

    it('should create valid accessor for indices', () => {
      const geometryResult = createTestGeometryResult(1);
      const exporter = new GLTFExporter(geometryResult);

      const { json } = exporter.exportGLTF();
      const gltf = JSON.parse(json);

      // Check index accessor - should be SCALAR type
      const indexAccessor = gltf.accessors?.find((a: any) => a.type === 'SCALAR');
      expect(indexAccessor).toBeTruthy();
      expect(indexAccessor.count).toBe(3); // Should have 3 indices (1 triangle)
    });

    it('should preserve mesh structure in scene graph', () => {
      const meshCount = 3;
      const geometryResult = createTestGeometryResult(meshCount);
      const exporter = new GLTFExporter(geometryResult);

      const { json } = exporter.exportGLTF();
      const gltf = JSON.parse(json);

      // Scene should reference all nodes
      const scene = gltf.scenes?.[0];
      expect(scene).toBeTruthy();
      expect(scene.nodes?.length).toBe(meshCount);

      // Each node should reference a mesh
      for (const node of gltf.nodes) {
        expect(node.mesh).toBeDefined();
      }
    });

    it('should filter hidden meshes when visibleOnly is set', () => {
      const geometryResult = createTestGeometryResult(4);
      const exporter = new GLTFExporter(geometryResult);
      const hiddenEntityIds = new Set<number>([2, 3]); // hide meshes 2 and 3

      const { json } = exporter.exportGLTF({
        visibleOnly: true,
        hiddenEntityIds,
      });
      const gltf = JSON.parse(json);

      // Only meshes 1 and 4 should remain
      expect(gltf.nodes.length).toBe(2);
    });

    it('should restrict export to isolated set when provided', () => {
      const geometryResult = createTestGeometryResult(4);
      const exporter = new GLTFExporter(geometryResult);
      const isolatedEntityIds = new Set<number>([1, 3]); // only keep 1 and 3

      const { json } = exporter.exportGLTF({
        visibleOnly: true,
        isolatedEntityIds,
      });
      const gltf = JSON.parse(json);

      expect(gltf.nodes.length).toBe(2);
    });

    it('should ignore filters when visibleOnly is false', () => {
      const geometryResult = createTestGeometryResult(3);
      const exporter = new GLTFExporter(geometryResult);
      const hiddenEntityIds = new Set<number>([1, 2, 3]);

      const { json } = exporter.exportGLTF({
        visibleOnly: false,
        hiddenEntityIds,
      });
      const gltf = JSON.parse(json);

      // visibleOnly off → hidden set has no effect
      expect(gltf.nodes.length).toBe(3);
    });

    it('should pick shadingColor when colorSource is "shading"', () => {
      const mesh: MeshData = {
        ...createTestMesh(1),
        color: [0.8, 0.2, 0.2, 1.0],
        shadingColor: [0.1, 0.1, 0.1, 1.0],
      };
      const geometryResult: GeometryResult = {
        meshes: [mesh],
        totalVertices: 3,
        totalTriangles: 1,
        coordinateInfo: {
          originShift: { x: 0, y: 0, z: 0 },
          originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
          hasLargeCoordinates: false,
        },
      };
      const exporter = new GLTFExporter(geometryResult);

      const { json } = exporter.exportGLTF({ colorSource: 'shading' });
      const gltf = JSON.parse(json);
      const baseColor = gltf.materials[0].pbrMetallicRoughness.baseColorFactor;

      // Shading colour wins
      expect(baseColor[0]).toBeCloseTo(0.1);
      expect(baseColor[1]).toBeCloseTo(0.1);
    });

    it('should fall back to color when colorSource is "shading" but mesh has no shadingColor', () => {
      const mesh: MeshData = {
        ...createTestMesh(1),
        color: [0.8, 0.2, 0.2, 1.0],
        // no shadingColor — the common case
      };
      const geometryResult: GeometryResult = {
        meshes: [mesh],
        totalVertices: 3,
        totalTriangles: 1,
        coordinateInfo: {
          originShift: { x: 0, y: 0, z: 0 },
          originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
          hasLargeCoordinates: false,
        },
      };
      const exporter = new GLTFExporter(geometryResult);

      const { json } = exporter.exportGLTF({ colorSource: 'shading' });
      const gltf = JSON.parse(json);
      const baseColor = gltf.materials[0].pbrMetallicRoughness.baseColorFactor;

      // Rendering colour kept (fallback)
      expect(baseColor[0]).toBeCloseTo(0.8);
      expect(baseColor[1]).toBeCloseTo(0.2);
    });

    it('should reject empty geometry with clear error', () => {
      const geometryResult: GeometryResult = {
        meshes: [],
        totalVertices: 0,
        totalTriangles: 0,
        coordinateInfo: {
          originShift: { x: 0, y: 0, z: 0 },
          originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
          hasLargeCoordinates: false,
        },
      };
      const exporter = new GLTFExporter(geometryResult);

      // Should throw with clear error message
      expect(() => exporter.exportGLTF()).toThrow(/no valid geometry/i);
    });
  });
});
