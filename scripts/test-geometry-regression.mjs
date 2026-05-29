#!/usr/bin/env node
/**
 * Geometry Regression Tests
 * 
 * Comprehensive test suite using diverse IFC files to catch geometry parsing regressions.
 * Tests multiple geometry types, building types, and edge cases.
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'tests/models');

console.log('🧪 Geometry Regression Tests (Comprehensive)\n');

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasmBuffer);
const api = new IfcAPI();
console.log('✅ WASM initialized\n');

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
    failed++;
  }
}

/**
 * Analyze mesh quality and return issues found
 */
function analyzeMeshQuality(mesh) {
  const vertices = mesh.positions;
  const indices = mesh.indices;
  const normals = mesh.normals;
  const vertexCount = mesh.vertexCount;
  const triangleCount = mesh.triangleCount;

  const issues = [];

  // Check bounding box reasonableness
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3];
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];

    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      issues.push(`Non-finite coordinates at vertex ${i}`);
      continue;
    }

    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const maxSize = Math.max(sizeX, sizeY, sizeZ);

  // Check for unreasonably large bounding boxes (e.g., 1km spans for small elements)
  if (maxSize > 1000) {
    issues.push(`Unreasonably large bounding box: ${maxSize.toFixed(1)}m span`);
  }

  // Check for flat geometry (all vertices in a plane)
  const FLAT_THRESHOLD = 0.001; // 1mm
  if (sizeX < FLAT_THRESHOLD || sizeY < FLAT_THRESHOLD || sizeZ < FLAT_THRESHOLD) {
    issues.push(`Flat geometry detected: size (${sizeX.toFixed(6)}, ${sizeY.toFixed(6)}, ${sizeZ.toFixed(6)})`);
  }

  // Check vertex clusters (fragmented geometry)
  const clusters = new Map();
  const clusterSize = 50; // 50m bins
  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3];
    const y = vertices[i * 3 + 1];
    const cx = Math.floor(x / clusterSize);
    const cy = Math.floor(y / clusterSize);
    const key = `${cx},${cy}`;
    clusters.set(key, (clusters.get(key) || 0) + 1);
  }

  if (clusters.size > 3) {
    issues.push(`Fragmented geometry: ${clusters.size} separate vertex clusters`);
  }

  // Analyze triangles
  let degenerateCount = 0;
  let stretchedCount = 0;
  const AREA_THRESHOLD = 1e-8;
  const EDGE_THRESHOLD = 50; // 50m edge threshold

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) {
      issues.push(`Invalid triangle indices at triangle ${t}`);
      continue;
    }

    const p0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
    const p1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
    const p2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];

    // Check for stretched triangles
    const edge01 = Math.sqrt((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2 + (p1[2] - p0[2]) ** 2);
    const edge12 = Math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2 + (p2[2] - p1[2]) ** 2);
    const edge20 = Math.sqrt((p0[0] - p2[0]) ** 2 + (p0[1] - p2[1]) ** 2 + (p0[2] - p2[2]) ** 2);
    const maxEdge = Math.max(edge01, edge12, edge20);

    if (maxEdge > EDGE_THRESHOLD) {
      stretchedCount++;
    }

    // Check for degenerate triangles
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const area = 0.5 * Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);

    if (area === 0 || area < AREA_THRESHOLD) {
      degenerateCount++;
    }
  }

  if (degenerateCount > 0) {
    issues.push(`${degenerateCount} degenerate triangles (zero or near-zero area)`);
  }

  if (stretchedCount > 0) {
    const ratio = (stretchedCount / triangleCount * 100).toFixed(1);
    issues.push(`${stretchedCount} stretched triangles (edge > ${EDGE_THRESHOLD}m) - ${ratio}%`);
  }

  // Validate normals
  if (normals.length === vertices.length) {
    let invalidNormalCount = 0;
    for (let i = 0; i < vertexCount; i++) {
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];

      if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) {
        invalidNormalCount++;
        continue;
      }

      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 0.9 || len > 1.1) {
        invalidNormalCount++;
      }
    }

    if (invalidNormalCount > 0) {
      issues.push(`${invalidNormalCount} invalid normals (non-unit length or non-finite)`);
    }
  }

  return issues;
}

function testFile(filePath, expectations) {
  const fileName = basename(filePath);

  if (!existsSync(filePath)) {
    console.log(`  ⏭️  ${fileName} (file not found)`);
    skipped++;
    return;
  }

  test(fileName, () => {
    const content = readFileSync(filePath, 'utf-8');
    const collection = parseMeshesViaPrePass(api, content);

    try {
      // For minMeshes > 0, enforce the minimum
      if (expectations.minMeshes !== undefined && expectations.minMeshes > 0) {
        assert.ok(collection.length >= expectations.minMeshes,
          `Expected >= ${expectations.minMeshes} meshes, got ${collection.length}`);
      }
      // For minMeshes === 0, just verify parsing didn't crash (no assertion needed)

      if (expectations.minVertices !== undefined) {
        assert.ok(collection.totalVertices >= expectations.minVertices,
          `Expected >= ${expectations.minVertices} vertices, got ${collection.totalVertices}`);
      }

      if (expectations.minTriangles !== undefined) {
        assert.ok(collection.totalTriangles >= expectations.minTriangles,
          `Expected >= ${expectations.minTriangles} triangles, got ${collection.totalTriangles}`);
      }

      // Verify mesh integrity and quality for all meshes (if any)
      const maxMeshesToCheck = Math.min(collection.length, 10);
      let totalQualityIssues = 0;

      for (let i = 0; i < maxMeshesToCheck; i++) {
        const mesh = collection.get(i);
        assert.ok(mesh.positions.length > 0, 'Should have positions');
        assert.ok(mesh.indices.length > 0, 'Should have indices');
        assert.equal(mesh.indices.length % 3, 0, 'Indices must form complete triangles');

        // Analyze mesh quality
        const qualityIssues = analyzeMeshQuality(mesh);
        if (qualityIssues.length > 0) {
          totalQualityIssues += qualityIssues.length;
          // Only fail on truly critical issues (not warnings)
          // Note: Fragmented geometry is a warning, not a critical issue,
          // as legitimate geometry can span large areas
          const criticalIssues = qualityIssues.filter(issue =>
            issue.includes('Non-finite') ||
            issue.includes('Invalid triangle')
          );

          if (criticalIssues.length > 0) {
            throw new Error(`Mesh ${i} (entity ${mesh.expressId}): ${criticalIssues.join('; ')}`);
          }
        }

        mesh.free();
      }

      // Warn if many quality issues found (but don't fail)
      if (totalQualityIssues > maxMeshesToCheck * 2) {
        console.log(`     ⚠️  Warning: ${totalQualityIssues} quality issues found in sampled meshes`);
      }
    } finally {
      collection.free();
    }
  });
}

// ===== BuildingSMART Official Test Files =====
console.log('📋 BuildingSMART Official Tests');

testFile(join(FIXTURES_DIR, 'buildingsmart/column-straight-rectangle-tessellation.ifc'), {
  minMeshes: 1,
  minVertices: 10,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/wall-with-opening-and-window.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/basin-tessellation.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/tessellated-item.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/tessellation-with-individual-colors.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/Building-Architecture.ifc'), {
  minMeshes: 10,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/Building-Structural.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/Building-Hvac.ifc'), {
  minMeshes: 1,
});

// ===== Infrastructure Models =====
console.log('\n📋 Infrastructure Models');

testFile(join(FIXTURES_DIR, 'buildingsmart/Infra-Bridge.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/Infra-Road.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'buildingsmart/Infra-Rail.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/ifcbridge-model01.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/KIT-Simple-Road-Test-Web-IFC4x3_RC2.ifc'), {
  minMeshes: 1,
});

// ===== Complex Building Models =====
console.log('\n📋 Complex Building Models');

testFile(join(FIXTURES_DIR, 'ara3d/duplex.ifc'), {
  minMeshes: 180,
  minVertices: 10000,
  minTriangles: 5000,
});

testFile(join(FIXTURES_DIR, 'ara3d/AC20-FZK-Haus.ifc'), {
  minMeshes: 50,
  minVertices: 5000,
});

testFile(join(FIXTURES_DIR, 'ara3d/IfcOpenHouse_IFC4.ifc'), {
  minMeshes: 10,
});

testFile(join(FIXTURES_DIR, 'ara3d/Office_A_20110811.ifc'), {
  minMeshes: 50,
});

testFile(join(FIXTURES_DIR, 'ara3d/dental_clinic.ifc'), {
  minMeshes: 10,
});

testFile(join(FIXTURES_DIR, 'ara3d/schependomlaan.ifc'), {
  minMeshes: 50,
});

testFile(join(FIXTURES_DIR, 'ara3d/FM_ARC_DigitalHub.ifc'), {
  minMeshes: 10,
});

// ===== Geometry Edge Cases (IfcOpenShell) =====
console.log('\n📋 Geometry Edge Cases');

testFile(join(FIXTURES_DIR, 'ifcopenshell/faceted_brep.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/advanced_brep.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/cylinders.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/1019-column.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/1030-sphere.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/928-column.ifc'), {
  minMeshes: 1,
});

// These are curve/line edge cases that may not produce solid geometry
testFile(join(FIXTURES_DIR, 'ifcopenshell/452--line-segment-straight.ifc'), {
  minMeshes: 0, // Line segments may not produce meshes
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/452--line-segment--curved.ifc'), {
  minMeshes: 0, // Curved segments may not produce meshes
});

testFile(join(FIXTURES_DIR, 'ifcopenshell/single-circle-compcurve.ifc'), {
  minMeshes: 0, // Circle comp curves may not produce meshes
});

// ===== Issue-Specific Regression Tests =====
console.log('\n📋 Issue-Specific Regressions');

testFile(join(FIXTURES_DIR, 'ara3d/ISSUE_044_test_IFCCOMPOSITEPROFILEDEF.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/ISSUE_005_haus.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/ISSUE_034_HouseZ.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'ara3d/ISSUE_159_kleine_Wohnung_R22.ifc'), {
  minMeshes: 1,
});

// ===== Various Test Files =====
console.log('\n📋 Various Test Files');

testFile(join(FIXTURES_DIR, 'various/test-colors.ifc'), {
  minMeshes: 1,
});

testFile(join(FIXTURES_DIR, 'various/01_BIMcollab_Example_ARC.ifc'), {
  minMeshes: 10,
});

testFile(join(FIXTURES_DIR, 'various/rvt01.ifc'), {
  minMeshes: 1,
});

// ===== IFCLINEINDEX Regression Test =====
console.log('\n📋 IFCLINEINDEX Regression Test');

test('IFCLINEINDEX elements produce geometry (regression)', () => {
  const content = readFileSync(join(FIXTURES_DIR, 'ara3d/duplex.ifc'), 'utf-8');
  const collection = parseMeshesViaPrePass(api, content);

  try {
    const meshExpressIds = new Set();
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      meshExpressIds.add(mesh.expressId);
      mesh.free();
    }

    const geometryEntities = api.scanGeometryEntitiesFast(content);

    let geometryEntitiesWithMeshes = 0;
    for (const entity of geometryEntities) {
      // `scanGeometryEntitiesFast` returns the normalized `expressId` field
      // (PR #818 scan-API normalization), not the old `express_id`.
      if (meshExpressIds.has(entity.expressId)) {
        geometryEntitiesWithMeshes++;
      }
    }

    const successRate = geometryEntitiesWithMeshes / geometryEntities.length;
    assert.ok(successRate >= 0.005,
      `Very low geometry success rate: ${(successRate * 100).toFixed(1)}%`);

    assert.ok(geometryEntitiesWithMeshes >= 100,
      `Expected >= 100 entities to produce meshes, got ${geometryEntitiesWithMeshes}`);
  } finally {
    collection.free();
  }
});

// ===== Stress Test with Large File =====
console.log('\n📋 Stress Test');

test('AC20-FZK-Haus processes without crash', () => {
  const content = readFileSync(join(FIXTURES_DIR, 'ara3d/AC20-FZK-Haus.ifc'), 'utf-8');
  const collection = parseMeshesViaPrePass(api, content);

  try {
    // Should produce substantial geometry
    assert.ok(collection.length >= 50, `Expected >= 50 meshes, got ${collection.length}`);
    assert.ok(collection.totalVertices >= 5000, `Expected >= 5000 vertices`);

    // Verify no infinite loops or crashes by checking reasonable bounds
    assert.ok(collection.totalVertices < 10_000_000, 'Vertex count should be reasonable');
    assert.ok(collection.totalTriangles < 5_000_000, 'Triangle count should be reasonable');
  } finally {
    collection.free();
  }
});

// ===== Summary =====
console.log(`\n${'─'.repeat(50)}`);
console.log(`📊 Test Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`   Total files tested: ${passed + failed}`);
console.log(`${'─'.repeat(50)}`);

if (failed > 0) {
  console.error('\n❌ Some regression tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All regression tests passed!');
  process.exit(0);
}
