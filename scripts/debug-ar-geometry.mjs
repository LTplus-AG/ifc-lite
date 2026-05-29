/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Debug script for AR.ifc geometry issues
 * Targets: #742451 (railing), #433788 (covering), #439648 (covering)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, IfcAPI } from "../packages/wasm/pkg/ifc-lite.js";
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const IFC_FILE = join(ROOT_DIR, "tests/models/local/AR.ifc");
const TARGET_ENTITIES = [
  { expressId: 746014, globalId: "12_xLsc_f3OgK3Ufdk0gTi", name: "Railing (disc)" },
  { expressId: 747827, globalId: "12_xLsc_f3OgK3Ufdk0hCK", name: "Railing 2 (disc)" },
  { expressId: 618635, globalId: "12_xLsc_f3OgK3Ufdk0efo", name: "Covering (disc)" },
];

console.log("🔍 Debug AR.ifc Geometry Issues\n");

// Load WASM
console.log("📦 Loading WASM...");
const wasmBuffer = readFileSync(join(ROOT_DIR, "packages/wasm/pkg/ifc-lite_bg.wasm"));
initSync(wasmBuffer);
const api = new IfcAPI();
console.log("✅ WASM initialized\n");

// Load IFC file
console.log(`📖 Reading ${IFC_FILE}...`);
const content = readFileSync(IFC_FILE, "utf-8");
console.log(`✅ File loaded (${(content.length / 1024 / 1024).toFixed(2)} MB)\n`);

// Parse meshes
console.log("🔧 Parsing meshes...");
const collection = parseMeshesViaPrePass(api, content);

// Get RTC offset
const rtcOffset = {
  x: collection.rtcOffsetX,
  y: collection.rtcOffsetY,
  z: collection.rtcOffsetZ,
};
const rtcDistance = Math.sqrt(rtcOffset.x ** 2 + rtcOffset.y ** 2 + rtcOffset.z ** 2);

console.log("📍 RTC Offset Detection:");
console.log(`  RTC offset: (${rtcOffset.x.toFixed(2)}, ${rtcOffset.y.toFixed(2)}, ${rtcOffset.z.toFixed(2)})`);
console.log(`  Distance from origin: ${rtcDistance.toFixed(2)}m\n`);

// Build entity index using correct API
const meshCount = collection.length;
console.log(`📊 Total meshes found: ${meshCount}\n`);

const entityMap = new Map();
const allExpressIds = [];
for (let i = 0; i < meshCount; i++) {
  const mesh = collection.get(i);
  if (mesh && mesh.expressId) {
    entityMap.set(mesh.expressId, { index: i, mesh });
    allExpressIds.push(mesh.expressId);
  }
}

// Show express ID range
allExpressIds.sort((a, b) => a - b);
console.log(`📊 Total Express IDs collected: ${allExpressIds.length}`);
if (allExpressIds.length > 0) {
  console.log(`📊 Express ID range: ${allExpressIds[0]} - ${allExpressIds[allExpressIds.length - 1]}`);

  // Check for IDs near targets
  for (const target of TARGET_ENTITIES) {
    const nearbyIds = allExpressIds.filter(id => Math.abs(id - target.expressId) < 1000);
    if (nearbyIds.length > 0) {
      console.log(`  Near ${target.name} (#${target.expressId}): ${nearbyIds.slice(0, 5).join(", ")}${nearbyIds.length > 5 ? "..." : ""}`);
    } else {
      console.log(`  Near ${target.name} (#${target.expressId}): NO IDs within 1000`);
    }
  }
} else {
  console.log("⚠️  No Express IDs were collected!");
}
console.log();

// Analyze each target entity
for (const target of TARGET_ENTITIES) {
  console.log("═".repeat(70));
  console.log(`🎯 ${target.name}: Express ID #${target.expressId} (${target.globalId})`);
  console.log("═".repeat(70));

  const entry = entityMap.get(target.expressId);
  if (!entry) {
    console.log("  ❌ NOT FOUND in parsed meshes\n");

    // Try to find nearby IDs
    const nearbyIds = Array.from(entityMap.keys())
      .filter(id => Math.abs(id - target.expressId) < 100)
      .sort((a, b) => a - b);

    if (nearbyIds.length > 0) {
      console.log(`  Nearby IDs found: ${nearbyIds.slice(0, 10).join(", ")}`);
    }
    continue;
  }

  const mesh = entry.mesh;
  const vertices = mesh.positions;  // Use 'positions' not 'vertices'
  const indices = mesh.indices;
  const normals = mesh.normals;

  const vertexCount = mesh.vertexCount;
  const triangleCount = mesh.triangleCount;
  const normalCount = normals.length / 3;

  console.log(`  IFC Type: ${mesh.ifcType || "Unknown"}`);
  console.log(`  Vertices: ${vertexCount}`);
  console.log(`  Triangles: ${triangleCount}`);
  console.log(`  Normals: ${normalCount}`);

  // Compute bounding box and find outliers
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Also track vertex clusters
  const clusters = new Map();
  const clusterSize = 50; // Group vertices in 50m bins

  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3];
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);

    // Track clusters
    const cx = Math.floor(x / clusterSize);
    const cy = Math.floor(y / clusterSize);
    const key = `${cx},${cy}`;
    clusters.set(key, (clusters.get(key) || 0) + 1);
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;

  console.log("\n  📦 Bounding Box:");
  console.log(`    Min: (${minX.toFixed(4)}, ${minY.toFixed(4)}, ${minZ.toFixed(4)})`);
  console.log(`    Max: (${maxX.toFixed(4)}, ${maxY.toFixed(4)}, ${maxZ.toFixed(4)})`);
  console.log(`    Size: (${sizeX.toFixed(4)}, ${sizeY.toFixed(4)}, ${sizeZ.toFixed(4)})`);

  // Check for flatness
  const FLAT_THRESHOLD = 0.001; // 1mm
  const isFlat = sizeX < FLAT_THRESHOLD || sizeY < FLAT_THRESHOLD || sizeZ < FLAT_THRESHOLD;

  if (isFlat) {
    console.log(`    ⚠️  FLAT GEOMETRY DETECTED!`);
    if (sizeX < FLAT_THRESHOLD) console.log(`      X dimension ${sizeX.toFixed(6)}m is < ${FLAT_THRESHOLD}m`);
    if (sizeY < FLAT_THRESHOLD) console.log(`      Y dimension ${sizeY.toFixed(6)}m is < ${FLAT_THRESHOLD}m`);
    if (sizeZ < FLAT_THRESHOLD) console.log(`      Z dimension ${sizeZ.toFixed(6)}m is < ${FLAT_THRESHOLD}m`);
  } else {
    console.log(`    ✅ Mesh has proper 3D extent`);
  }

  // Show vertex clusters
  if (clusters.size > 1) {
    console.log(`\n  🎯 Vertex Clusters (${clusterSize}m bins):`);
    const sorted = [...clusters.entries()].sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const [key, count] = sorted[i];
      const [cx, cy] = key.split(',').map(Number);
      console.log(`    Bin (${cx * clusterSize} to ${(cx + 1) * clusterSize}, ${cy * clusterSize} to ${(cy + 1) * clusterSize}): ${count} vertices`);
    }
    if (sorted.length > 10) {
      console.log(`    ... and ${sorted.length - 10} more clusters`);
    }
    if (sorted.length > 3) {
      console.log(`    ⚠️  ${sorted.length} separate clusters - geometry may be fragmented!`);
    }
  }

  // Check coordinate magnitudes
  const maxCoord = Math.max(
    Math.abs(minX), Math.abs(maxX),
    Math.abs(minY), Math.abs(maxY),
    Math.abs(minZ), Math.abs(maxZ)
  );

  console.log(`\n  📏 Coordinate Analysis:`);
  console.log(`    Max coordinate magnitude: ${maxCoord.toFixed(2)}m`);

  if (maxCoord > 10000) {
    console.log(`    ⚠️  Large coordinates - RTC may not be applied correctly`);
    console.log(`    Expected world coords: ~(${(rtcOffset.x + (minX + maxX) / 2).toFixed(0)}, ${(rtcOffset.y + (minY + maxY) / 2).toFixed(0)}, ${(rtcOffset.z + (minZ + maxZ) / 2).toFixed(0)})`);
  } else {
    console.log(`    ✅ Coordinates properly shifted (small relative to RTC)`);
  }

  // Sample vertices - first, middle, last
  console.log("\n  📐 Sample Vertices (first 3, middle 3, last 3):");
  const sampleIndices = [0, 1, 2, Math.floor(vertexCount / 2) - 1, Math.floor(vertexCount / 2), Math.floor(vertexCount / 2) + 1, vertexCount - 3, vertexCount - 2, vertexCount - 1];
  for (const i of sampleIndices) {
    if (i >= 0 && i < vertexCount) {
      const x = vertices[i * 3];
      const y = vertices[i * 3 + 1];
      const z = vertices[i * 3 + 2];
      console.log(`    V${i}: (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`);
    }
  }

  // Sample normals
  console.log("\n  🧭 Sample Normals (first 3):");
  for (let i = 0; i < Math.min(3, normalCount); i++) {
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    console.log(`    N${i}: (${nx.toFixed(4)}, ${ny.toFixed(4)}, ${nz.toFixed(4)}) [len=${len.toFixed(4)}]`);
  }

  // Analyze triangles for degenerate faces
  console.log("\n  🔺 Triangle Analysis:");
  let degenerateCount = 0;
  let tinyAreaCount = 0;
  let stretchedCount = 0;
  const AREA_THRESHOLD = 1e-8;
  const EDGE_THRESHOLD = 50; // 50m edge is suspicious

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const p0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
    const p1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
    const p2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];

    // Check for stretched triangles (long edges)
    const edge01 = Math.sqrt((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2 + (p1[2] - p0[2]) ** 2);
    const edge12 = Math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2 + (p2[2] - p1[2]) ** 2);
    const edge20 = Math.sqrt((p0[0] - p2[0]) ** 2 + (p0[1] - p2[1]) ** 2 + (p0[2] - p2[2]) ** 2);
    const maxEdge = Math.max(edge01, edge12, edge20);

    if (maxEdge > EDGE_THRESHOLD) {
      stretchedCount++;
      if (stretchedCount <= 3) {
        console.log(`    ⚠️  Stretched triangle #${t}: edge=${maxEdge.toFixed(1)}m`);
        console.log(`       V${i0}: (${p0[0].toFixed(1)}, ${p0[1].toFixed(1)})`);
        console.log(`       V${i1}: (${p1[0].toFixed(1)}, ${p1[1].toFixed(1)})`);
        console.log(`       V${i2}: (${p2[0].toFixed(1)}, ${p2[1].toFixed(1)})`);
      }
    }

    // Edge vectors
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

    // Cross product
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const area = 0.5 * Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);

    if (area === 0) {
      degenerateCount++;
    } else if (area < AREA_THRESHOLD) {
      tinyAreaCount++;
    }
  }

  console.log(`    Degenerate triangles (zero area): ${degenerateCount}`);
  console.log(`    Tiny triangles (< ${AREA_THRESHOLD} m²): ${tinyAreaCount}`);
  console.log(`    Stretched triangles (edge > ${EDGE_THRESHOLD}m): ${stretchedCount}`);

  if (degenerateCount > 0 || stretchedCount > 0) {
    console.log(`    ⚠️  Mesh quality issues detected`);
  } else {
    console.log(`    ✅ Triangle quality OK`);
  }

  console.log();
}

console.log("═".repeat(70));
console.log("📋 ANALYSIS COMPLETE");
console.log("═".repeat(70));
