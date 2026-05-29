#!/usr/bin/env node
/**
 * Reference-Based Geometry Testing
 * 
 * Compares parsed geometry output against golden reference files to detect
 * regressions in geometric correctness, not just counts.
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'tests/models');
const REFERENCES_DIR = join(ROOT_DIR, 'tests/references');

// Ensure references directory exists
if (!existsSync(REFERENCES_DIR)) {
  mkdirSync(REFERENCES_DIR, { recursive: true });
}

console.log('📊 Reference-Based Geometry Tests\n');

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasmBuffer);
const api = new IfcAPI();
console.log('✅ WASM initialized\n');

let passed = 0;
let failed = 0;
let updated = 0;

/**
 * Extract geometry statistics from a mesh collection
 */
function extractGeometryStats(collection) {
  const stats = {
    totalMeshes: collection.length,
    totalVertices: collection.totalVertices,
    totalTriangles: collection.totalTriangles,
    rtcOffset: {
      x: collection.rtcOffsetX,
      y: collection.rtcOffsetY,
      z: collection.rtcOffsetZ,
    },
    meshes: [],
  };

  // Sample up to 20 meshes for detailed stats
  const sampleSize = Math.min(collection.length, 20);
  for (let i = 0; i < sampleSize; i++) {
    const mesh = collection.get(i);
    const vertices = mesh.positions;
    const indices = mesh.indices;

    // Compute bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let j = 0; j < mesh.vertexCount; j++) {
      const x = vertices[j * 3];
      const y = vertices[j * 3 + 1];
      const z = vertices[j * 3 + 2];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    stats.meshes.push({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      boundingBox: {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      },
    });

    mesh.free();
  }

  return stats;
}

/**
 * Compare current stats against reference with tolerance
 */
function compareStats(current, reference, tolerance = 0.05) {
  const issues = [];

  // Compare totals
  if (Math.abs(current.totalMeshes - reference.totalMeshes) > reference.totalMeshes * tolerance) {
    issues.push(`Mesh count mismatch: ${current.totalMeshes} vs ${reference.totalMeshes} (expected)`);
  }

  if (Math.abs(current.totalVertices - reference.totalVertices) > reference.totalVertices * tolerance) {
    issues.push(`Vertex count mismatch: ${current.totalVertices} vs ${reference.totalVertices} (expected)`);
  }

  if (Math.abs(current.totalTriangles - reference.totalTriangles) > reference.totalTriangles * tolerance) {
    issues.push(`Triangle count mismatch: ${current.totalTriangles} vs ${reference.totalTriangles} (expected)`);
  }

  // Compare RTC offset (should be identical)
  if (Math.abs(current.rtcOffset.x - reference.rtcOffset.x) > 0.01 ||
    Math.abs(current.rtcOffset.y - reference.rtcOffset.y) > 0.01 ||
    Math.abs(current.rtcOffset.z - reference.rtcOffset.z) > 0.01) {
    issues.push(`RTC offset mismatch: (${current.rtcOffset.x}, ${current.rtcOffset.y}, ${current.rtcOffset.z}) vs (${reference.rtcOffset.x}, ${reference.rtcOffset.y}, ${reference.rtcOffset.z})`);
  }

  // Compare mesh bounding boxes (if available)
  if (current.meshes.length > 0 && reference.meshes.length > 0) {
    const minLength = Math.min(current.meshes.length, reference.meshes.length);
    for (let i = 0; i < minLength; i++) {
      const curr = current.meshes[i];
      const ref = reference.meshes[i];

      if (curr.expressId !== ref.expressId) {
        issues.push(`Mesh ${i}: Express ID mismatch ${curr.expressId} vs ${ref.expressId}`);
        continue;
      }

      const currSize = curr.boundingBox.size;
      const refSize = ref.boundingBox.size;

      // Check for significant size changes (e.g., 1km spans appearing)
      const sizeDiff = Math.max(
        Math.abs(currSize.x - refSize.x),
        Math.abs(currSize.y - refSize.y),
        Math.abs(currSize.z - refSize.z)
      );

      if (sizeDiff > 100) { // 100m threshold
        issues.push(`Mesh ${curr.expressId}: Bounding box size changed significantly (${sizeDiff.toFixed(1)}m difference)`);
      }

      // Check for unreasonably large bounding boxes
      const maxSize = Math.max(currSize.x, currSize.y, currSize.z);
      if (maxSize > 1000) {
        issues.push(`Mesh ${curr.expressId}: Unreasonably large bounding box (${maxSize.toFixed(1)}m)`);
      }
    }
  }

  return issues;
}

function testFile(filePath, options = {}) {
  const fileName = basename(filePath);
  const referencePath = join(REFERENCES_DIR, `${fileName}.json`);
  const updateReference = process.env.UPDATE_REFERENCES === 'true' || options.updateReference;

  if (!existsSync(filePath)) {
    console.log(`  ⏭️  ${fileName} (file not found)`);
    return;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const collection = parseMeshesViaPrePass(api, content);

    try {
      const currentStats = extractGeometryStats(collection);

      if (!existsSync(referencePath) || updateReference) {
        // Generate or update reference
        writeFileSync(referencePath, JSON.stringify(currentStats, null, 2));
        console.log(`  📝 ${fileName} - ${existsSync(referencePath) ? 'Updated' : 'Created'} reference`);
        updated++;
        return;
      }

      // Compare against reference
      const referenceStats = JSON.parse(readFileSync(referencePath, 'utf-8'));
      const issues = compareStats(currentStats, referenceStats, options.tolerance || 0.05);

      if (issues.length > 0) {
        console.log(`  ❌ ${fileName}`);
        issues.forEach(issue => console.log(`     ${issue}`));
        failed++;
      } else {
        console.log(`  ✅ ${fileName}`);
        passed++;
      }
    } finally {
      collection.free();
    }
  } catch (error) {
    console.log(`  ❌ ${fileName}`);
    console.log(`     ${error.message}`);
    failed++;
  }
}

// Test key files that are known to have geometry issues
console.log('📋 Key Test Files (Reference-Based)\n');

// Test the problematic AR.ifc file
const arIfcPath = join(FIXTURES_DIR, 'local/AR.ifc');
if (existsSync(arIfcPath)) {
  testFile(arIfcPath, { tolerance: 0.1 }); // 10% tolerance for large files
}

// Test rvt01.ifc (has railing issues)
testFile(join(FIXTURES_DIR, 'various/rvt01.ifc'));

// Test duplex.ifc (complex building)
testFile(join(FIXTURES_DIR, 'ara3d/duplex.ifc'), { tolerance: 0.1 });

// Test BuildingSMART official files
testFile(join(FIXTURES_DIR, 'buildingsmart/Building-Architecture.ifc'));

// Summary
const updateReferences = process.env.UPDATE_REFERENCES === 'true';
console.log(`\n${'─'.repeat(50)}`);
console.log(`📊 Test Results: ${passed} passed, ${failed} failed, ${updated} ${updated === 1 ? 'reference' : 'references'} ${updated > 0 ? (updateReferences ? 'updated' : 'created') : ''}`);
console.log(`${'─'.repeat(50)}`);

if (updateReferences) {
  console.log('\n💡 References updated. Run again without UPDATE_REFERENCES=true to test.');
} else if (failed > 0) {
  console.error('\n❌ Some reference tests failed!');
  console.error('   Run with UPDATE_REFERENCES=true to update references if changes are expected.');
  process.exit(1);
} else {
  console.log('\n✅ All reference tests passed!');
  process.exit(0);
}
