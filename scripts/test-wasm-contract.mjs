#!/usr/bin/env node
/**
 * WASM API Contract Tests
 *
 * Tests the public API contract of the WASM bindings.
 * Focus on structural invariants, not exact values.
 */

import { readFileSync, existsSync } from 'fs';
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

// Per AGENTS.md §Test fixtures: skip cleanly (exit 0) when fixtures or
// the wasm runtime aren't on disk, pointing at the command that fixes it.
const WASM_BIN = join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm');
if (!existsSync(WASM_BIN)) {
  console.log('⚠️  wasm runtime missing — run `bash scripts/build-wasm.sh`. Skipping.');
  process.exit(0);
}
if (!existsSync(COLUMN_IFC)) {
  console.log('⚠️  column fixture missing — run `pnpm fixtures`. Skipping.');
  process.exit(0);
}
const GEOREF_AVAILABLE = existsSync(GEOREF_IFC);
if (!GEOREF_AVAILABLE) {
  console.log('⚠️  georef fixture missing — run `pnpm fixtures`. Georef tests will be skipped.');
}

// Initialize WASM
console.log('📦 Loading WASM...');
const wasmBuffer = readFileSync(WASM_BIN);
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

test('issue #1023: raw byte geometry and scans accept non-UTF-8 string bytes', () => {
  const bytes = new TextEncoder().encode(columnContent);
  const marker = new TextEncoder().encode('Column #1');
  const markerStart = bytes.findIndex((_, index) =>
    marker.every((byte, offset) => bytes[index + offset] === byte));
  assert.ok(markerStart >= 0, 'fixture marker must exist');
  bytes[markerStart] = 0xe9;

  const refs = api.scanEntitiesFastBytes(bytes);
  assert.ok(refs.length > 0, 'byte scan must still find entities');

  const pre = api.buildPrePassOnce(bytes);
  try {
    assert.ok(pre.totalJobs > 0, 'pre-pass must still produce geometry jobs');
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      assert.ok(collection.length > 0, 'geometry batch must still produce meshes');
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
});

// ===== Pre-pass contract (viewer boundary) =====
// The TS GeometryProcessor (packages/geometry) destructures these exact
// fields off buildPrePassOnce() and forwards them to processGeometryBatch.
// If a wasm-bindings change renames or drops one, the viewer breaks at
// runtime while every mocked TS test stays green — this pins the contract.
console.log('\n📋 buildPrePassOnce contract');

test('pre-pass exposes every field the viewer consumes', () => {
  const bytes = new TextEncoder().encode(columnContent);
  const pre = api.buildPrePassOnce(bytes);
  try {
    assert.equal(typeof pre.totalJobs, 'number');
    assert.ok(pre.jobs, 'jobs must exist');
    assert.equal(typeof pre.unitScale, 'number');
    assert.ok(pre.rtcOffset, 'rtcOffset must exist');
    assert.equal(pre.rtcOffset.length, 3, 'rtcOffset must be [x, y, z]');
    for (const v of pre.rtcOffset) {
      assert.ok(Number.isFinite(v), 'rtcOffset components must be finite');
    }
    assert.equal(typeof pre.needsShift, 'boolean');
    assert.equal(typeof pre.buildingRotation, 'number');
    // Void + style transport arrays (may be empty, must be present)
    for (const key of ['voidKeys', 'voidCounts', 'voidValues', 'styleIds', 'styleColors']) {
      assert.ok(pre[key] !== undefined && pre[key] !== null, `${key} must exist`);
    }
  } finally {
    api.clearPrePassCache();
  }
});

test('unit scale resolves conversion-based units (inch fixture → 0.0254)', () => {
  // column-straight-rectangle-tessellation.ifc declares METRE as the SI
  // unit but overrides length with IFCCONVERSIONBASEDUNIT 'inch'. The
  // recurring unit-bug class is exactly this chain resolving wrong.
  const bytes = new TextEncoder().encode(columnContent);
  const pre = api.buildPrePassOnce(bytes);
  try {
    assert.ok(Math.abs(pre.unitScale - 0.0254) < 1e-9,
      `inch model must yield unitScale 0.0254, got ${pre.unitScale}`);
  } finally {
    api.clearPrePassCache();
  }
});

test('prepass resolves planeAngleToRadians on the wire', () => {
  // The shared resolver (prepass::resolve_unit_scales) resolves BOTH unit
  // scales once and ships the plane-angle scale to workers so batch decoders
  // are seeded instead of re-paying an O(file) IFCPROJECT hunt per call.
  const bytes = new TextEncoder().encode(columnContent);
  const pre = api.buildPrePassOnce(bytes);
  try {
    assert.equal(typeof pre.planeAngleToRadians, 'number',
      'buildPrePassOnce must carry planeAngleToRadians');
    assert.ok(pre.planeAngleToRadians > 0,
      `plane-angle scale must be positive, got ${pre.planeAngleToRadians}`);
  } finally {
    api.clearPrePassCache();
  }
});

test('streaming meta resolves units with IFCPROJECT moved to the END of DATA', () => {
  // IfcOpenShell/Revit exports put IFCPROJECT + the unit chain near the end
  // of the file. The streaming prepass must not wait for it (workers would
  // idle until ~90% of the scan) NOR default silently to metres — the shared
  // resolver finds the project by SIMD substring search and re-resolves
  // against a full index. Transplant the fixture's project + unit chain to
  // the end of DATA and require identical meta.
  const projectBlock = [];
  const remaining = [];
  for (const line of columnContent.split('\n')) {
    if (/^#\d+=\s*IFC(PROJECT|UNITASSIGNMENT|SIUNIT|CONVERSIONBASEDUNIT|MEASUREWITHUNIT|DIMENSIONALEXPONENTS)\(/.test(line)) {
      projectBlock.push(line);
    } else {
      remaining.push(line);
    }
  }
  assert.ok(projectBlock.length >= 2, 'fixture must contain a project + unit chain');
  const joined = remaining.join('\n');
  // Splice before the LAST `ENDSEC;` — the first one closes the HEADER.
  const lastEnd = joined.lastIndexOf('ENDSEC;');
  assert.ok(lastEnd > 0, 'fixture must close its DATA section');
  const lateProject =
    joined.slice(0, lastEnd) + projectBlock.join('\n') + '\n' + joined.slice(lastEnd);
  assert.ok(lateProject.includes('IFCPROJECT'), 'transplant kept the project');
  assert.ok(
    lateProject.indexOf('IFCPROJECT') > lateProject.length / 2,
    'project must now sit in the back half of the file',
  );

  const bytes = new TextEncoder().encode(lateProject);
  const events = [];
  api.buildPrePassStreaming(bytes, (evt) => events.push(evt), 4096);
  api.clearPrePassCache();

  const meta = events.find((e) => e.type === 'meta');
  assert.ok(meta, 'streaming must emit meta');
  assert.ok(Math.abs(meta.unitScale - 0.0254) < 1e-9,
    `late-IFCPROJECT inch model must still yield unitScale 0.0254, got ${meta.unitScale}`);
  assert.equal(typeof meta.planeAngleToRadians, 'number',
    'meta must carry planeAngleToRadians');
  const complete = events.find((e) => e.type === 'complete');
  assert.ok(complete && complete.totalJobs > 0, 'streaming must complete with jobs');
});

test('unit scale resolves plain SI metres (georef fixture → 1.0)', () => {
  if (!GEOREF_AVAILABLE) {
    console.log('     (skipped — georef fixture missing, run `pnpm fixtures`)');
    return;
  }
  const georefContent = readFileSync(GEOREF_IFC, 'utf-8');
  const bytes = new TextEncoder().encode(georefContent);
  const pre = api.buildPrePassOnce(bytes);
  try {
    assert.equal(pre.unitScale, 1, `metre model must yield unitScale 1, got ${pre.unitScale}`);
    assert.equal(pre.needsShift, false, 'local-coordinate model must not trigger RTC shift');
  } finally {
    api.clearPrePassCache();
  }
});

test('mesh output is metre-normalized (column fits a sane bbox)', () => {
  // The inch fixture's column is ~3 m tall. If unit scaling silently
  // stopped being applied, positions come out in inches (×39) — assert
  // the overall bbox stays in building-scale metres.
  const collection = parseMeshesViaPrePass(api, columnContent);
  assert.ok(collection.length > 0, 'fixture must mesh');
  let maxAbs = 0;
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    for (let j = 0; j < mesh.positions.length; j++) {
      const a = Math.abs(mesh.positions[j]);
      if (a > maxAbs) maxAbs = a;
    }
    mesh.free();
  }
  assert.ok(maxAbs > 0.1, `column extent ${maxAbs} suspiciously small — unit scale over-applied?`);
  assert.ok(maxAbs < 50, `column extent ${maxAbs} m — unit scale not applied?`);
  collection.free();
});

// ===== RTC rebase (>10km national-grid coordinates) =====
console.log('\n📋 RTC rebase (>10km)');

// The wasm pre-pass flags `needsShift` when the detected RTC offset exceeds
// 10 km on any axis. The threshold constant is `10000.0` (metres, after
// unit-scaling) in:
//   - rust/wasm-bindings/src/api/gpu_meshes.rs (`needs_shift = rtc_offset.N.abs() > 10000.0`)
//   - rust/geometry/src/router/processing.rs (`rtc_offset_from_translations`,
//     `const THRESHOLD: f64 = 10000.0` — median element translation gate)
//   - rust/core/src/model_bounds.rs (`has_large_coordinates`, `THRESHOLD = 10000.0`)
const RTC_THRESHOLD_M = 10000.0;

// The column fixture is authored in INCHES (IFCCONVERSIONBASEDUNIT 0.0254 m);
// the RTC offset is detected in unit-scaled METRES, so planted coordinates
// must be written in inches and asserted in metres.
const INCH_TO_M = 0.0254;
// Column local placement inside the fixture: #125 = (432, 288, 48) inches,
// i.e. ~ (10.97, 7.32, 1.22) m on top of whatever the site placement adds.
const COLUMN_LOCAL_X_M = 432 * INCH_TO_M;
const COLUMN_LOCAL_Y_M = 288 * INCH_TO_M;

/**
 * Transplant the site placement origin (#68, parent of the column's
 * IfcLocalPlacement chain) to the given coordinates in metres.
 */
function withSiteOriginMetres(xMetres, yMetres) {
  const xIn = (xMetres / INCH_TO_M).toFixed(1);
  const yIn = (yMetres / INCH_TO_M).toFixed(1);
  const pattern = /#68\s*=\s*IFCCARTESIANPOINT\(\([^)]*\)\);/;
  assert.ok(pattern.test(columnContent), 'Fixture should contain site placement point #68');
  return columnContent.replace(pattern, `#68= IFCCARTESIANPOINT((${xIn},${yIn},0.));`);
}

test('national-grid coordinates (Swiss LV95) should trigger the RTC rebase', () => {
  // Swiss LV95 origin-ish coordinates: X=2_600_000 m, Y=1_200_000 m.
  const SWISS_X_M = 2_600_000;
  const SWISS_Y_M = 1_200_000;
  const moved = withSiteOriginMetres(SWISS_X_M, SWISS_Y_M);
  assert.notEqual(moved, columnContent, 'Placement transplant must change the content');

  const collection = parseMeshesViaPrePass(api, moved);

  // (a) pre-pass must flag the shift.
  assert.equal(collection.hasRtcOffset(), true, 'needsShift should be true for >10km coords');

  // (b) rtcOffset (metres) within ~1km of the planted coordinates.
  // Expected exact value = planted site origin + column local placement.
  assert.ok(
    Math.abs(collection.rtcOffsetX - (SWISS_X_M + COLUMN_LOCAL_X_M)) < 1000,
    `rtcOffsetX ${collection.rtcOffsetX} should be within 1km of ${SWISS_X_M}`,
  );
  assert.ok(
    Math.abs(collection.rtcOffsetY - (SWISS_Y_M + COLUMN_LOCAL_Y_M)) < 1000,
    `rtcOffsetY ${collection.rtcOffsetY} should be within 1km of ${SWISS_Y_M}`,
  );
  assert.ok(
    Math.abs(collection.rtcOffsetZ) < 1000,
    `rtcOffsetZ ${collection.rtcOffsetZ} should stay near 0`,
  );

  // (c) the rebase must actually move geometry into the render frame:
  // every output vertex must be near the origin, not at national-grid scale.
  assert.ok(collection.length > 0, 'Moved column should still mesh');
  let maxAbs = 0;
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    for (let j = 0; j < mesh.positions.length; j++) {
      maxAbs = Math.max(maxAbs, Math.abs(mesh.positions[j]));
    }
    mesh.free();
  }
  assert.ok(
    maxAbs < RTC_THRESHOLD_M,
    `Rebased positions must be near origin (<${RTC_THRESHOLD_M}), got max |p| = ${maxAbs}`,
  );

  collection.free();
});

test('coordinates just under the 10km threshold should NOT trigger the shift', () => {
  // needs_shift uses a strict `> 10000.0` comparison on the unit-scaled
  // median element translation. Plant the site so the COMPOSED column
  // translation (site + ~10.97m local) lands just under 10_000 m.
  const NEAR_X_M = 9_950; // composed ≈ 9_960.97 m < 10_000 m
  const NEAR_Y_M = 9_950; // composed ≈ 9_957.32 m < 10_000 m
  const moved = withSiteOriginMetres(NEAR_X_M, NEAR_Y_M);
  assert.notEqual(moved, columnContent, 'Placement transplant must change the content');

  const collection = parseMeshesViaPrePass(api, moved);

  assert.equal(collection.hasRtcOffset(), false, 'needsShift must stay false under 10km');
  assert.equal(collection.rtcOffsetX, 0, 'rtcOffset must stay [0,0,0] under threshold');
  assert.equal(collection.rtcOffsetY, 0, 'rtcOffset must stay [0,0,0] under threshold');
  assert.equal(collection.rtcOffsetZ, 0, 'rtcOffset must stay [0,0,0] under threshold');

  // No rebase ⇒ geometry stays at its (large-ish) world position. Positions are
  // stored in the per-element local frame (world = origin + position) on the
  // wasm path, so fold the origin back before checking the world magnitude
  // (origin is [0,0,0] / absent on an absolute-coordinate build → unchanged).
  assert.ok(collection.length > 0, 'Moved column should still mesh');
  let maxAbs = 0;
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    const o = mesh.origin;
    for (let j = 0; j < mesh.positions.length; j++) {
      const world = mesh.positions[j] + (o ? o[j % 3] : 0);
      maxAbs = Math.max(maxAbs, Math.abs(world));
    }
    mesh.free();
  }
  assert.ok(
    maxAbs > 9000,
    `Unshifted geometry should stay near its 9.95km placement, got max |world| = ${maxAbs}`,
  );

  collection.free();
});

test('unmodified small-coordinate model keeps needsShift=false', () => {
  const collection = parseMeshesViaPrePass(api, columnContent);
  assert.equal(collection.hasRtcOffset(), false, 'Origin-scale model must not be rebased');
  assert.equal(collection.rtcOffsetX, 0);
  assert.equal(collection.rtcOffsetY, 0);
  assert.equal(collection.rtcOffsetZ, 0);
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

// ===== export boundary (Rust ifc-lite-export) =====
console.log('\n📋 export (exportGlb / exportKmz)');

// A real GLB from the column fixture — also the input the KMZ packer consumes.
const glbBytes = api.exportGlb(new TextEncoder().encode(columnContent), false, new Uint32Array(), new Uint32Array(), '');

test('exportGlb returns a binary glTF (GLB magic "glTF") with real meshes', () => {
  assert.ok(glbBytes instanceof Uint8Array, 'GLB should be a Uint8Array');
  assert.ok(glbBytes.length > 20, 'GLB should be non-trivial');
  assert.deepEqual(Array.from(glbBytes.slice(0, 4)), [0x67, 0x6c, 0x54, 0x46]); // "glTF"
  // Guard that the export actually carried geometry. The IFC source must cross
  // the boundary as a Uint8Array; if it ever arrived empty (e.g. a string coerced
  // to zero bytes), the GLB would still be structurally valid yet declare zero
  // meshes — caught here.
  const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const gltf = JSON.parse(Buffer.from(glbBytes.buffer, glbBytes.byteOffset + 20, jsonLen).toString('utf-8'));
  assert.ok(Array.isArray(gltf.meshes) && gltf.meshes.length > 0, 'GLB should declare meshes');
});

test('exportKmz packs a stored-zip KMZ (PK header, doc.kml + model.glb, axis-derived heading)', () => {
  const kmz = api.exportKmz(glbBytes, 47.5, 8.5, 412, 1, 0, 'Contract Bldg');
  assert.ok(kmz instanceof Uint8Array, 'KMZ should be a Uint8Array');
  assert.deepEqual(Array.from(kmz.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
  const text = Buffer.from(kmz).toString('latin1');
  assert.ok(text.includes('doc.kml'), 'archive names doc.kml');
  assert.ok(text.includes('model.glb'), 'archive names model.glb');
  assert.ok(text.includes('<heading>90</heading>'), 'heading derived from grid axis (1,0) → 90');
  assert.ok(text.includes('Contract Bldg'), 'placemark name present');
});

test('exportKmz accepts undefined optional grid axes at the JS boundary (heading 0)', () => {
  // Exercises the Rust Option<f64> params as `undefined` (the shim detail Codex flagged).
  const kmz = api.exportKmz(glbBytes, 0, 0, 0, undefined, undefined, '');
  assert.ok(kmz instanceof Uint8Array);
  assert.ok(Buffer.from(kmz).toString('latin1').includes('<heading>0</heading>'), 'undefined axes → heading 0');
});

// ===== Pipeline diagnostics channel (wasm boundary) =====
// This replaces the orphaned rust/wasm-bindings/tests/pipeline_diagnostics.rs
// (a #![cfg(target_arch="wasm32")] test no CI lane ran) with an assertion in
// the lane that DOES gate (node-tests -> the required Build+WASM+Rust+Node
// check). It pins the versioned wire shape across the real serde-wasm-bindgen
// boundary, mirroring the Rust serde-key stability test.
test('getPipelineDiagnostics: undefined before load, accumulates across batches, versioned, persists post-load, resets on the next load', () => {
  const diagApi = new IfcAPI();
  const bytes = new TextEncoder().encode(columnContent);
  try {
    assert.equal(diagApi.getPipelineDiagnostics(), undefined,
      'diagnostics must be undefined before any batch runs');

    // One load = one buildPrePassOnce (which resets the accumulator) followed by
    // N processGeometryBatch calls (the viewer's per-batch loop).
    const pre = diagApi.buildPrePassOnce(bytes);
    assert.ok(pre.totalJobs > 0, 'fixture must produce geometry jobs');
    const runBatch = () => {
      const c = diagApi.processGeometryBatch(
        bytes, pre.jobs, pre.unitScale,
        pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      );
      c.free();
    };

    runBatch();
    const one = diagApi.getPipelineDiagnostics();
    assert.ok(one && typeof one === 'object', 'diagnostics must be an object after a batch');
    // Versioned wire shape: the schema-stability contract on the real boundary.
    assert.equal(one.schemaVersion, 1, 'schemaVersion must match the pinned contract (bump = breaking)');
    assert.equal(one.batches, 1, 'exactly one batch recorded');
    // Real VALUES, not just key presence: the column fixture has geometry, so a
    // serde bug emitting zero/wrong counts would be caught.
    assert.ok(one.meshCount > 0, 'meshCount > 0');
    assert.ok(one.triangleCount > 0, 'triangleCount > 0');
    assert.ok(one.elementCount > 0, 'elementCount > 0');
    for (const key of ['backstopCount', 'totalCsgFailures', 'productsWithFailures',
      'hostsWithOpenings', 'silentNoOps', 'rectFast', 'phaseMs']) {
      assert.ok(key in one, `diagnostics must carry ${key}`);
    }
    for (const key of ['entityScanMs', 'lookupMs', 'preprocessMs', 'parseMs', 'geometryMs', 'totalMs']) {
      assert.ok(key in one.phaseMs, `phaseMs must carry ${key}`);
    }

    // A second processGeometryBatch of the SAME load ACCUMULATES: record_batch
    // sums per batch, so batches increments and the counts never decrease.
    runBatch();
    const two = diagApi.getPipelineDiagnostics();
    assert.equal(two.batches, 2, 'batches accumulate across processGeometryBatch calls');
    assert.ok(two.meshCount >= one.meshCount, 'meshCount accumulates (monotonic)');
    assert.ok(two.elementCount >= one.elementCount, 'elementCount accumulates (monotonic)');
    assert.ok(two.triangleCount >= one.triangleCount, 'triangleCount accumulates (monotonic)');

    // Diagnostics survive clearPrePassCache: it runs at end-of-load, and a host
    // reads the per-load diagnostics AFTER it (see IfcAPI::clear_pre_pass_cache,
    // which clears the entity/parts caches but NOT the accumulator).
    diagApi.clearPrePassCache();
    assert.ok(diagApi.getPipelineDiagnostics(), 'diagnostics persist for reading after clearPrePassCache');

    // The next load resets the accumulator (buildPrePassOnce calls
    // reset_pipeline_diagnostics before the new batch runs).
    diagApi.buildPrePassOnce(bytes);
    assert.equal(diagApi.getPipelineDiagnostics(), undefined,
      'a new load (buildPrePassOnce) resets the accumulator until its first batch');
  } finally {
    diagApi.clearPrePassCache();
  }
});

// ===== setEntityIndex (production load-start reset path, #1551) =====
// The `getPipelineDiagnostics` test above only exercises the buildPrePassOnce
// reset. `setEntityIndex` is the OTHER load-start reset path: the geometry
// PROCESS worker (packages/geometry/src/geometry.worker.ts) is a separate
// wasm realm from the pre-pass worker, so it never calls buildPrePassOnce
// itself — it receives an already-built entity index over SAB and installs
// it via setEntityIndex before its first processGeometryBatch. Nothing
// previously asserted that this path resets load-scoped state the same way.
test('setEntityIndex resets pipeline diagnostics like a fresh load, and installs a working entity-index cache', () => {
  const entityIdxApi = new IfcAPI();
  const bytes = new TextEncoder().encode(columnContent);
  try {
    // First "load", via the normal buildPrePassOnce + processGeometryBatch
    // path, to put this IfcAPI into a NON-fresh state (diagnostics
    // populated) — the state setEntityIndex must reset on the next load.
    const pre = entityIdxApi.buildPrePassOnce(bytes);
    assert.ok(pre.totalJobs > 0, 'fixture must produce geometry jobs');
    const runBatch = () => {
      const c = entityIdxApi.processGeometryBatch(
        bytes, pre.jobs, pre.unitScale,
        pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      );
      try {
        assert.ok(c.length > 0, 'first-load batch must produce meshes');
      } finally {
        c.free();
      }
    };
    runBatch();
    const before = entityIdxApi.getPipelineDiagnostics();
    assert.ok(before && before.batches === 1, 'diagnostics must be populated before setEntityIndex');

    // Build the (ids, starts, lengths) columns the worker realm would receive
    // over SAB, the same way scanEntitiesFastBytes already exposes them.
    const refs = entityIdxApi.scanEntitiesFastBytes(bytes);
    assert.ok(Array.isArray(refs) && refs.length > 0, 'scan must find entities');
    const ids = Uint32Array.from(refs.map((r) => r.expressId));
    const starts = Uint32Array.from(refs.map((r) => r.byteOffset));
    const lengths = Uint32Array.from(refs.map((r) => r.byteLength));

    entityIdxApi.setEntityIndex(ids, starts, lengths);

    // (a) setEntityIndex is a load-START reset, same contract as
    // buildPrePassOnce (rust/wasm-bindings/src/api/mod.rs set_entity_index ->
    // reset_pipeline_diagnostics): the PREVIOUS load's diagnostics must not
    // leak into the next one on a reused IfcAPI.
    assert.equal(entityIdxApi.getPipelineDiagnostics(), undefined,
      'setEntityIndex must reset pipeline diagnostics like a fresh load');

    // (b) Functional correctness of the installed cache: a subsequent
    // processGeometryBatch must still produce valid meshes by reusing the
    // Arc<EntityIndex> setEntityIndex populated, not a silently empty/corrupt
    // one that would make every job fail to decode.
    const collection = entityIdxApi.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      assert.ok(collection.length > 0, 'batch after setEntityIndex must still produce meshes');
    } finally {
      collection.free();
    }
    const after = entityIdxApi.getPipelineDiagnostics();
    assert.ok(after && after.batches === 1,
      'the post-setEntityIndex batch must start a fresh accumulator at 1, not accumulate onto the prior load');
  } finally {
    entityIdxApi.clearPrePassCache();
  }
});

// Summary
console.log('\n' + '═'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
