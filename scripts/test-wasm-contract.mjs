#!/usr/bin/env node
/**
 * WASM API Contract Tests
 *
 * Tests the public API contract of the WASM bindings.
 * Focus on structural invariants, not exact values.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'tests/models');

// Test fixtures - small IFC files for fast tests
const COLUMN_IFC = join(FIXTURES_DIR, 'buildingsmart/column-straight-rectangle-tessellation.ifc');
const GEOREF_IFC = join(FIXTURES_DIR, 'ifc5/Georeferencing_georeferenced-bridge-deck.ifc');

console.log('🧪 WASM API Contract Tests\n');

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasmBuffer);
console.log('✅ WASM initialized\n');

// Load fixture files
const columnContent = readFileSync(COLUMN_IFC, 'utf-8');

// Create API
const api = new IfcAPI();

let passed = 0;
let failed = 0;

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

// ===== IfcAPI initialization =====
console.log('📋 IfcAPI initialization');

test('should be ready after construction', () => {
  assert.equal(api.is_ready, true);
});

test('should have a version string', () => {
  assert.equal(typeof api.version, 'string');
  assert.ok(api.version.length > 0);
});

// ===== parseMeshes =====
console.log('\n📋 parseMeshes');

test('should return a MeshCollection', () => {
  const collection = parseMeshesViaPrePass(api, columnContent);
  assert.ok(collection, 'Collection should exist');
  assert.equal(typeof collection.length, 'number');
  assert.ok(collection.length > 0, 'Should have at least one mesh');
  collection.free();
});

test('should produce meshes with valid structure', () => {
  const collection = parseMeshesViaPrePass(api, columnContent);

  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    assert.ok(mesh, `Mesh ${i} should exist`);

    // Structural invariants
    assert.equal(typeof mesh.expressId, 'number');
    assert.ok(mesh.expressId > 0, 'Express ID should be positive');

    assert.ok(mesh.positions instanceof Float32Array);
    assert.ok(mesh.normals instanceof Float32Array);
    assert.ok(mesh.indices instanceof Uint32Array);
    assert.ok(mesh.color instanceof Float32Array);

    // Positions must be triplets (x, y, z)
    assert.equal(mesh.positions.length % 3, 0, 'Positions must be triplets');

    // Normals must match position count
    assert.equal(mesh.normals.length, mesh.positions.length, 'Normals must match positions');

    // Indices must be valid (within vertex range)
    const vertexCount = mesh.positions.length / 3;
    for (let j = 0; j < mesh.indices.length; j++) {
      assert.ok(mesh.indices[j] < vertexCount, `Index ${j} out of range`);
    }

    // Color must be RGBA
    assert.equal(mesh.color.length, 4, 'Color must be RGBA');

    // IFC type should be a non-empty string
    assert.equal(typeof mesh.ifcType, 'string');
    assert.ok(mesh.ifcType.length > 0, 'IFC type should not be empty');

    mesh.free();
  }

  collection.free();
});

test('should have consistent vertex/triangle counts', () => {
  const collection = parseMeshesViaPrePass(api, columnContent);

  let totalVertices = 0;
  let totalTriangles = 0;

  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    totalVertices += mesh.vertexCount;
    totalTriangles += mesh.triangleCount;
    mesh.free();
  }

  assert.equal(collection.totalVertices, totalVertices);
  assert.equal(collection.totalTriangles, totalTriangles);

  collection.free();
});

test('should handle empty/minimal IFC content gracefully', () => {
  const minimalIfc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),'','','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
ENDSEC;
END-ISO-10303-21;`;

  const collection = parseMeshesViaPrePass(api, minimalIfc);
  assert.equal(collection.length, 0, 'Empty IFC should produce no meshes');
  collection.free();
});

// ===== scanEntitiesFast =====
console.log('\n📋 scanEntitiesFast');

test('should return entity scan results', () => {
  const result = api.scanEntitiesFast(columnContent);
  assert.ok(result, 'Scan result should exist');
  assert.ok(Array.isArray(result) || typeof result === 'object');
});

// ===== Error handling =====
console.log('\n📋 Error handling');

test('should handle completely invalid content gracefully', () => {
  // Parser is graceful - returns empty collection rather than throwing
  try {
    const collection = parseMeshesViaPrePass(api, 'not valid ifc content at all');
    assert.equal(collection.length, 0, 'Invalid content should produce empty collection');
    collection.free();
  } catch {
    // Throwing is also acceptable
  }
});

test('should handle truncated IFC content gracefully', () => {
  const truncated = columnContent.substring(0, 100);

  // Should either throw or return empty/partial result
  try {
    const collection = parseMeshesViaPrePass(api, truncated);
    assert.equal(typeof collection.length, 'number');
    collection.free();
  } catch {
    // Throwing is also acceptable
  }
});

// Summary
console.log('\n' + '═'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
