#!/usr/bin/env node
/**
 * Integration Pipeline Tests
 *
 * Tests the full IFC → parse → geometry pipeline.
 * Ensures packages work together correctly.
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

// Test fixtures
const COLUMN_IFC = join(FIXTURES_DIR, 'buildingsmart/column-straight-rectangle-tessellation.ifc');
const WALL_IFC = join(FIXTURES_DIR, 'buildingsmart/wall-with-opening-and-window.ifc');
const DUPLEX_IFC = join(FIXTURES_DIR, 'ara3d/duplex.ifc');

console.log('🧪 Integration Pipeline Tests\n');

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasmBuffer);
const api = new IfcAPI();
console.log('✅ WASM initialized\n');

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

// ===== Parse → Mesh Pipeline =====
console.log('📋 Parse → Mesh Pipeline');

test('column: parse produces valid geometry', () => {
  const content = readFileSync(COLUMN_IFC, 'utf-8');
  const collection = parseMeshesViaPrePass(api, content);

  assert.ok(collection.length > 0, 'Should produce meshes');

  // Verify mesh integrity
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);

    // Basic structure
    assert.ok(mesh.positions.length > 0, 'Should have positions');
    assert.ok(mesh.indices.length > 0, 'Should have indices');

    // Triangles must be complete
    assert.equal(mesh.indices.length % 3, 0, 'Indices must form complete triangles');

    // All indices must reference valid vertices
    const vertexCount = mesh.positions.length / 3;
    const maxIndex = Math.max(...mesh.indices);
    assert.ok(maxIndex < vertexCount, 'All indices must be valid');

    mesh.free();
  }

  collection.free();
});

test('wall with opening: parse handles boolean operations', () => {
  const content = readFileSync(WALL_IFC, 'utf-8');
  const collection = parseMeshesViaPrePass(api, content);

  // Wall with opening should still produce valid geometry
  assert.ok(collection.length > 0, 'Wall fixture should produce at least one mesh');

  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    assert.equal(mesh.positions.length % 3, 0, 'Positions must be triplets');
    mesh.free();
  }

  collection.free();
});

test('duplex: parse handles complex building model', () => {
  const content = readFileSync(DUPLEX_IFC, 'utf-8');
  const collection = parseMeshesViaPrePass(api, content);

  // Duplex is a complete building - should have many meshes
  assert.ok(collection.length > 10, 'Complex model should have many meshes');
  assert.ok(collection.totalVertices > 1000, 'Should have significant geometry');
  assert.ok(collection.totalTriangles > 500, 'Should have many triangles');

  collection.free();
});

// Summary
console.log('\n' + '═'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
