#!/usr/bin/env node
/**
 * Debug Script for Railing Geometry Issue
 * 
 * Investigates why railing entity #42086 in rvt01.ifc renders as a flat disc
 * instead of proper 3D geometry. Analyzes placement transforms, RTC offset,
 * mesh data, bounding boxes, and triangle winding order.
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const IFC_FILE = join(ROOT_DIR, 'tests/models/various/rvt01.ifc');
const TARGET_EXPRESS_ID = 42086; // Balcony railing entity

console.log('🔍 Debug Railing Geometry Issue\n');
console.log(`Target entity: Express ID #${TARGET_EXPRESS_ID}`);
console.log(`IFC file: ${IFC_FILE}\n`);

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasmBuffer);
const api = new IfcAPI();
console.log('✅ WASM initialized\n');

// Helper: Compute bounding box from positions
function computeBoundingBox(positions) {
  if (positions.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
  };
}

// Helper: Analyze triangle winding order
function analyzeWindingOrder(positions, indices) {
  if (indices.length < 3) {
    return { validTriangles: 0, clockwise: 0, counterClockwise: 0, degenerate: 0 };
  }

  let clockwise = 0;
  let counterClockwise = 0;
  let degenerate = 0;
  let validTriangles = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    if (i0 >= positions.length || i1 >= positions.length || i2 >= positions.length) {
      degenerate++;
      continue;
    }

    const p0 = { x: positions[i0], y: positions[i0 + 1], z: positions[i0 + 2] };
    const p1 = { x: positions[i1], y: positions[i1 + 1], z: positions[i1 + 2] };
    const p2 = { x: positions[i2], y: positions[i2 + 1], z: positions[i2 + 2] };

    // Compute normal using cross product
    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
    const v2 = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };

    const nx = v1.y * v2.z - v1.z * v2.y;
    const ny = v1.z * v2.x - v1.x * v2.z;
    const nz = v1.x * v2.y - v1.y * v2.x;

    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);

    if (normalLength < 1e-6) {
      degenerate++;
      continue;
    }

    validTriangles++;

    // Check if normal points mostly in Z direction (for floor plan view)
    // Positive Z = counter-clockwise, Negative Z = clockwise
    if (nz > 0.1) {
      counterClockwise++;
    } else if (nz < -0.1) {
      clockwise++;
    }
  }

  return { validTriangles, clockwise, counterClockwise, degenerate };
}

// Helper: Check if mesh appears flat (one dimension much smaller than others)
function isMeshFlat(bbox) {
  const { size } = bbox;
  const maxSize = Math.max(size.x, size.y, size.z);
  const minSize = Math.min(size.x, size.y, size.z);

  // If smallest dimension is < 1% of largest, consider it flat
  const flatnessRatio = minSize / maxSize;
  const isFlat = flatnessRatio < 0.01 && minSize < 0.1; // < 1% ratio and < 10cm thickness

  return { isFlat, flatnessRatio, minSize, maxSize };
}

// Main analysis
console.log('📖 Reading IFC file...');
const content = readFileSync(IFC_FILE, 'utf-8');
console.log(`✅ File loaded (${(content.length / 1024 / 1024).toFixed(2)} MB)\n`);

console.log('🔧 Parsing meshes...');
const collection = parseMeshesViaPrePass(api, content);

try {
  // Check RTC offset
  console.log('\n📍 RTC Offset Detection:');
  if (collection.hasRtcOffset && collection.hasRtcOffset()) {
    const rtcX = collection.rtcOffsetX;
    const rtcY = collection.rtcOffsetY;
    const rtcZ = collection.rtcOffsetZ;
    console.log(`  ✅ RTC offset detected: (${rtcX.toFixed(2)}, ${rtcY.toFixed(2)}, ${rtcZ.toFixed(2)})`);
    console.log(`  Distance from origin: ${Math.sqrt(rtcX ** 2 + rtcY ** 2 + rtcZ ** 2).toFixed(2)}m`);
  } else {
    console.log('  ⚠️  No RTC offset found (coordinates may be small)');
    console.log(`  RTC values: (${collection.rtcOffsetX.toFixed(2)}, ${collection.rtcOffsetY.toFixed(2)}, ${collection.rtcOffsetZ.toFixed(2)})`);
  }

  // Find target railing mesh
  console.log(`\n🔍 Searching for entity #${TARGET_EXPRESS_ID}...`);
  let targetMesh = null;
  let meshIndex = -1;

  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    if (mesh.expressId === TARGET_EXPRESS_ID) {
      targetMesh = mesh;
      meshIndex = i;
      break;
    }
    mesh.free();
  }

  if (!targetMesh) {
    console.log(`  ❌ Entity #${TARGET_EXPRESS_ID} not found in mesh collection`);
    console.log(`  Total meshes parsed: ${collection.length}`);
    console.log(`\n  Available express IDs (first 20):`);
    for (let i = 0; i < Math.min(collection.length, 20); i++) {
      const mesh = collection.get(i);
      console.log(`    #${mesh.expressId} (${mesh.ifcType})`);
      mesh.free();
    }
    process.exit(1);
  }

  console.log(`  ✅ Found mesh at index ${meshIndex}`);
  console.log(`  IFC Type: ${targetMesh.ifcType}`);

  // Extract mesh data
  const positions = new Float32Array(targetMesh.positions);
  const indices = new Uint32Array(targetMesh.indices);
  const normals = new Float32Array(targetMesh.normals);

  console.log(`\n📊 Mesh Statistics:`);
  console.log(`  Vertices: ${positions.length / 3}`);
  console.log(`  Triangles: ${indices.length / 3}`);
  console.log(`  Normals: ${normals.length > 0 ? normals.length / 3 : 'NONE (empty!)'}`);

  // Analyze bounding box
  console.log(`\n📦 Bounding Box Analysis:`);
  const bbox = computeBoundingBox(positions);
  console.log(`  Min: (${bbox.min.x.toFixed(3)}, ${bbox.min.y.toFixed(3)}, ${bbox.min.z.toFixed(3)})`);
  console.log(`  Max: (${bbox.max.x.toFixed(3)}, ${bbox.max.y.toFixed(3)}, ${bbox.max.z.toFixed(3)})`);
  console.log(`  Size: (${bbox.size.x.toFixed(3)}, ${bbox.size.y.toFixed(3)}, ${bbox.size.z.toFixed(3)})`);
  console.log(`  Center: (${bbox.center.x.toFixed(3)}, ${bbox.center.y.toFixed(3)}, ${bbox.center.z.toFixed(3)})`);

  // Check if coordinates are properly shifted (should be small relative to RTC)
  if (collection.hasRtcOffset && collection.hasRtcOffset()) {
    const rtcX = collection.rtcOffsetX;
    const rtcY = collection.rtcOffsetY;
    const rtcZ = collection.rtcOffsetZ;
    const maxCoord = Math.max(Math.abs(bbox.min.x), Math.abs(bbox.max.x),
      Math.abs(bbox.min.y), Math.abs(bbox.max.y),
      Math.abs(bbox.min.z), Math.abs(bbox.max.z));
    console.log(`  RTC offset: (${rtcX.toFixed(2)}, ${rtcY.toFixed(2)}, ${rtcZ.toFixed(2)})`);
    console.log(`  Max coordinate magnitude: ${maxCoord.toFixed(2)}m`);
    if (maxCoord > 50000) {
      console.log(`  ⚠️  Coordinates are VERY LARGE - RTC offset may not be applied correctly!`);
    } else if (maxCoord > 1000) {
      console.log(`  ⚠️  Coordinates are large - verify RTC is working`);
    } else {
      console.log(`  ✅ Coordinates are properly shifted (small relative to RTC)`);
    }
  }

  const flatness = isMeshFlat(bbox);
  if (flatness.isFlat) {
    console.log(`  ⚠️  MESH APPEARS FLAT!`);
    console.log(`  Flatness ratio: ${(flatness.flatnessRatio * 100).toFixed(2)}%`);
    console.log(`  Thinnest dimension: ${flatness.minSize.toFixed(3)}m`);
    console.log(`  Largest dimension: ${flatness.maxSize.toFixed(3)}m`);

    // Identify which dimension is flat
    if (bbox.size.z < 0.1) {
      console.log(`  🔴 Z dimension is collapsed (mesh is flat in XY plane)`);
    } else if (bbox.size.y < 0.1) {
      console.log(`  🔴 Y dimension is collapsed (mesh is flat in XZ plane)`);
    } else if (bbox.size.x < 0.1) {
      console.log(`  🔴 X dimension is collapsed (mesh is flat in YZ plane)`);
    }
  } else {
    console.log(`  ✅ Mesh has proper 3D extent`);
  }

  // Analyze winding order and triangle orientations
  console.log(`\n🔄 Triangle Winding Order & Orientation Analysis:`);
  const winding = analyzeWindingOrder(positions, indices);
  console.log(`  Valid triangles: ${winding.validTriangles}`);
  console.log(`  Clockwise (negative Z normal): ${winding.clockwise}`);
  console.log(`  Counter-clockwise (positive Z normal): ${winding.counterClockwise}`);
  console.log(`  Degenerate triangles: ${winding.degenerate}`);

  // Analyze triangle orientations (which axis they face)
  let facingX = 0, facingY = 0, facingZ = 0, facingOther = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    if (i0 >= positions.length || i1 >= positions.length || i2 >= positions.length) continue;

    const p0 = { x: positions[i0], y: positions[i0 + 1], z: positions[i0 + 2] };
    const p1 = { x: positions[i1], y: positions[i1 + 1], z: positions[i1 + 2] };
    const p2 = { x: positions[i2], y: positions[i2 + 1], z: positions[i2 + 2] };

    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
    const v2 = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };

    const nx = v1.y * v2.z - v1.z * v2.y;
    const ny = v1.z * v2.x - v1.x * v2.z;
    const nz = v1.x * v2.y - v1.y * v2.x;

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-6) continue;

    const n = { x: nx / len, y: ny / len, z: nz / len };
    const absX = Math.abs(n.x);
    const absY = Math.abs(n.y);
    const absZ = Math.abs(n.z);

    if (absX > 0.7) facingX++;
    else if (absY > 0.7) facingY++;
    else if (absZ > 0.7) facingZ++;
    else facingOther++;
  }

  console.log(`  Triangle orientations:`);
  const totalFacing = facingX + facingY + facingZ + facingOther;
  const pct = (n) => totalFacing > 0 ? (n / totalFacing * 100).toFixed(1) : '0.0';
  console.log(`    Facing X axis: ${facingX} (${pct(facingX)}%)`);
  console.log(`    Facing Y axis: ${facingY} (${pct(facingY)}%)`);
  console.log(`    Facing Z axis: ${facingZ} (${pct(facingZ)}%)`);
  console.log(`    Other orientations: ${facingOther} (${pct(facingOther)}%)`);

  if (winding.validTriangles === 0) {
    console.log(`  ❌ No valid triangles found!`);
  } else {
    const cwRatio = winding.clockwise / winding.validTriangles;
    const ccwRatio = winding.counterClockwise / winding.validTriangles;
    console.log(`  Clockwise ratio: ${(cwRatio * 100).toFixed(1)}%`);
    console.log(`  Counter-clockwise ratio: ${(ccwRatio * 100).toFixed(1)}%`);

    // For vertical surfaces (railing), most normals should be horizontal (X/Y), not Z
    if (facingZ > winding.validTriangles * 0.5) {
      console.log(`  ⚠️  Most triangles face Z axis - railing may appear flat from top view`);
    }
  }

  // Analyze normals
  console.log(`\n🧭 Normal Analysis:`);
  if (normals.length === 0) {
    console.log(`  ❌ NO NORMALS! This could cause flat appearance`);
    console.log(`  Normals should be computed after mesh extraction`);
  } else {
    let zeroNormals = 0;
    let unitNormals = 0;
    let invalidNormals = 0;

    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      if (!isFinite(len) || len < 1e-6) {
        zeroNormals++;
      } else if (Math.abs(len - 1.0) < 0.1) {
        unitNormals++;
      } else {
        invalidNormals++;
      }
    }

    console.log(`  Total normals: ${normals.length / 3}`);
    console.log(`  Unit length (~1.0): ${unitNormals}`);
    console.log(`  Zero length: ${zeroNormals}`);
    console.log(`  Invalid length: ${invalidNormals}`);

    if (zeroNormals > normals.length / 6) {
      console.log(`  ⚠️  Many zero-length normals - may cause rendering issues`);
    }
  }

  // Sample first few vertices
  console.log(`\n📐 Sample Vertex Data (first 5 vertices):`);
  for (let i = 0; i < Math.min(5, positions.length / 3); i++) {
    const idx = i * 3;
    const x = positions[idx];
    const y = positions[idx + 1];
    const z = positions[idx + 2];
    console.log(`  Vertex ${i}: (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`);

    if (normals.length > idx + 2) {
      const nx = normals[idx];
      const ny = normals[idx + 1];
      const nz = normals[idx + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      console.log(`    Normal: (${nx.toFixed(3)}, ${ny.toFixed(3)}, ${nz.toFixed(3)}) [len=${len.toFixed(3)}]`);
    }
  }

  // Sample first few triangles
  console.log(`\n🔺 Sample Triangle Data (first 3 triangles):`);
  for (let i = 0; i < Math.min(3, indices.length / 3); i++) {
    const idx = i * 3;
    const i0 = indices[idx];
    const i1 = indices[idx + 1];
    const i2 = indices[idx + 2];

    const p0 = { x: positions[i0 * 3], y: positions[i0 * 3 + 1], z: positions[i0 * 3 + 2] };
    const p1 = { x: positions[i1 * 3], y: positions[i1 * 3 + 1], z: positions[i1 * 3 + 2] };
    const p2 = { x: positions[i2 * 3], y: positions[i2 * 3 + 1], z: positions[i2 * 3 + 2] };

    console.log(`  Triangle ${i}: indices [${i0}, ${i1}, ${i2}]`);
    console.log(`    P0: (${p0.x.toFixed(3)}, ${p0.y.toFixed(3)}, ${p0.z.toFixed(3)})`);
    console.log(`    P1: (${p1.x.toFixed(3)}, ${p1.y.toFixed(3)}, ${p1.z.toFixed(3)})`);
    console.log(`    P2: (${p2.x.toFixed(3)}, ${p2.y.toFixed(3)}, ${p2.z.toFixed(3)})`);

    // Compute triangle normal
    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
    const v2 = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };
    const nx = v1.y * v2.z - v1.z * v2.y;
    const ny = v1.z * v2.x - v1.x * v2.z;
    const nz = v1.x * v2.y - v1.y * v2.x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
      console.log(`    Computed normal: (${(nx / len).toFixed(3)}, ${(ny / len).toFixed(3)}, ${(nz / len).toFixed(3)})`);
    }
  }

  // Summary and diagnosis
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 DIAGNOSIS SUMMARY`);
  console.log(`${'='.repeat(60)}`);

  const issues = [];
  if (flatness.isFlat) {
    issues.push(`Mesh is FLAT (${(flatness.flatnessRatio * 100).toFixed(1)}% flatness ratio)`);
  }
  if (normals.length === 0) {
    issues.push(`NO NORMALS - normals array is empty`);
  }
  if (winding.validTriangles === 0) {
    issues.push(`NO VALID TRIANGLES - all triangles are degenerate`);
  }
  if (winding.degenerate > winding.validTriangles * 0.1) {
    issues.push(`Many degenerate triangles (${winding.degenerate})`);
  }

  if (issues.length === 0) {
    console.log(`✅ No obvious issues detected in mesh data`);
    console.log(`   The flat appearance may be due to:`);
    console.log(`   - Rendering/viewport issue (camera angle, culling)`);
    console.log(`   - Transform applied incorrectly in viewer`);
    console.log(`   - Z-up to Y-up conversion issue`);
  } else {
    console.log(`⚠️  Issues detected:`);
    issues.forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue}`);
    });
  }

  console.log(`\n💡 Next steps:`);
  if (flatness.isFlat) {
    console.log(`   - Check if placement transform is collapsing Z dimension`);
    console.log(`   - Verify RTC offset is applied correctly`);
    console.log(`   - Check if Z-up to Y-up conversion is flattening mesh`);
  }
  if (normals.length === 0) {
    console.log(`   - Normals should be computed in PolygonalFaceSetProcessor or after extraction`);
    console.log(`   - Check if normal computation is failing silently`);
  }

  targetMesh.free();
} finally {
  collection.free();
}

console.log(`\n✅ Analysis complete\n`);
