#!/usr/bin/env node
/**
 * IFC-Lite Integration Test
 * Tests the parseMeshes API with a sample IFC file
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc_lite_wasm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

console.log('🧪 IFC-Lite Integration Test\n');

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc_lite_wasm_bg.wasm'));
initSync(wasmBuffer);
console.log('✅ WASM initialized\n');

// Load test file (with colors)
console.log('📁 Loading test IFC file with colors...');
const fixturePath = join(ROOT_DIR, 'tests/models/various/test-colors.ifc');
let ifcData;
try {
  ifcData = readFileSync(fixturePath, 'utf-8');
  if (ifcData.startsWith('version https://git-lfs.github.com/spec/')) {
    console.error(`❌ Fixture is still a Git LFS pointer: ${fixturePath}`);
    console.error('   Run `pnpm fixtures` from the repo root to download the real bytes.');
    process.exit(2);
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`❌ Fixture not found: ${fixturePath}`);
    console.error('   Run `pnpm fixtures` from the repo root to download it.');
    process.exit(2);
  }
  throw err;
}
console.log(`   File size: ${ifcData.length} bytes`);
console.log(`   Lines: ${ifcData.split('\n').length}\n`);

// Create API
const api = new IfcAPI();
console.log(`📌 IFC-Lite version: ${api.version}`);
console.log(`   API ready: ${api.is_ready}\n`);

// Test 1: parseMeshes
console.log('🔬 Test 1: parseMeshes()');
console.log('─'.repeat(50));

const startParse = performance.now();
const meshCollection = api.parseMeshes(ifcData);
const parseTime = performance.now() - startParse;

console.log(`   Parse time: ${parseTime.toFixed(2)}ms`);
console.log(`   Mesh count: ${meshCollection.length}`);
console.log(`   Total vertices: ${meshCollection.totalVertices}`);
console.log(`   Total triangles: ${meshCollection.totalTriangles}`);

if (meshCollection.length > 0) {
  console.log('\n📊 Mesh Details:');
  for (let i = 0; i < meshCollection.length; i++) {
    const mesh = meshCollection.get(i);
    if (mesh) {
      const color = mesh.color;
      console.log(`   Mesh ${i + 1}:`);
      console.log(`     Express ID: ${mesh.expressId}`);
      console.log(`     Vertices: ${mesh.vertexCount}`);
      console.log(`     Triangles: ${mesh.triangleCount}`);
      console.log(`     Color: rgba(${color[0].toFixed(2)}, ${color[1].toFixed(2)}, ${color[2].toFixed(2)}, ${color[3].toFixed(2)})`);
      console.log(`     Positions: [${mesh.positions.slice(0, 6).map(v => v.toFixed(1)).join(', ')}...]`);
      console.log(`     Normals: [${mesh.normals.slice(0, 6).map(v => v.toFixed(2)).join(', ')}...]`);
      console.log(`     Indices: [${mesh.indices.slice(0, 6).join(', ')}...]`);
      mesh.free();
    }
  }
}

// Store results before freeing
const meshCount = meshCollection.length;
const totalVerts = meshCollection.totalVertices;
const totalTris = meshCollection.totalTriangles;
meshCollection.free();

// Test 2: parseZeroCopy
console.log('\n🔬 Test 2: parseZeroCopy()');
console.log('─'.repeat(50));

const startZeroCopy = performance.now();
const zeroCopyMesh = api.parseZeroCopy(ifcData);
const zeroCopyTime = performance.now() - startZeroCopy;

const zcVertexCount = zeroCopyMesh.vertex_count;
const zcTriangleCount = zeroCopyMesh.triangle_count;
const zcIsEmpty = zeroCopyMesh.is_empty;

console.log(`   Parse time: ${zeroCopyTime.toFixed(2)}ms`);
console.log(`   Vertices: ${zcVertexCount}`);
console.log(`   Triangles: ${zcTriangleCount}`);
console.log(`   Is empty: ${zcIsEmpty}`);

if (!zcIsEmpty) {
  const boundsMin = zeroCopyMesh.bounds_min();
  const boundsMax = zeroCopyMesh.bounds_max();
  console.log(`   Bounds min: (${boundsMin[0].toFixed(1)}, ${boundsMin[1].toFixed(1)}, ${boundsMin[2].toFixed(1)})`);
  console.log(`   Bounds max: (${boundsMax[0].toFixed(1)}, ${boundsMax[1].toFixed(1)}, ${boundsMax[2].toFixed(1)})`);
}

zeroCopyMesh.free();

// Summary
console.log('\n📊 Test Summary');
console.log('═'.repeat(50));
console.log(`✅ parseMeshes: ${meshCount > 0 ? 'PASS' : 'FAIL'} (${parseTime.toFixed(2)}ms, ${meshCount} meshes, ${totalVerts} verts, ${totalTris} tris)`);
console.log(`✅ parseZeroCopy: ${!zcIsEmpty ? 'PASS' : 'FAIL'} (${zeroCopyTime.toFixed(2)}ms, ${zcVertexCount} verts, ${zcTriangleCount} tris)`);
console.log('\n✨ Integration test complete!\n');
