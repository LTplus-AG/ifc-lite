#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
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
import gltfValidator from 'gltf-validator';
import {
  initSync,
  IfcAPI,
  Contours2D,
  union2d,
  difference2d,
  intersection2d,
  resolve2d,
  meshOutline2d,
  splitMeshByZones,
} from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';
import { runPrepassClassBoundaryTests } from './lib/prepass-class-boundary.mjs';
import { runShardRefusalBoundaryTests } from './lib/shard-refusal-boundary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(ROOT_DIR, 'tests/models');

// Test fixtures - small IFC files for fast tests
const COLUMN_IFC = join(FIXTURES_DIR, 'buildingsmart/column-straight-rectangle-tessellation.ifc');
const GEOREF_IFC = join(FIXTURES_DIR, 'ifc5/Georeferencing_georeferenced-bridge-deck.ifc');
// Carries IfcSpace volumes, so the energy-model exporters have something to emit.
const SPACES_IFC = join(FIXTURES_DIR, 'buildingsmart/Building-Architecture.ifc');
// Carries IfcMaterialLayerSetUsage on its walls, so the layer-slice branch of
// `produce_element_geometry` actually runs and tags meshes GEOM_CLASS_LAYER_SLICE.
// None of the fixtures above has a multi-layer wall: the two Building-* models
// have no IFCMATERIALLAYERSET at all, and wall-with-opening-and-window.ifc has a
// single-layer set, which Rust classifies NotSliceable on purpose.
const LAYERED_IFC = join(FIXTURES_DIR, 'ara3d/duplex.ifc');
/** Spelled once: every skip below points at the command that undoes it. */
const FIXTURES_HINT = 'run `pnpm fixtures`';

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
const LAYERED_AVAILABLE = existsSync(LAYERED_IFC);
if (!LAYERED_AVAILABLE) {
  console.log('⚠️  layered-wall fixture missing — run `pnpm fixtures`. geometryClass pin will be skipped.');
}
const SPACES_AVAILABLE = existsSync(SPACES_IFC);
if (!SPACES_AVAILABLE) {
  console.log('⚠️  spaces fixture missing — run `pnpm fixtures`. Energy-model tests will be skipped.');
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
let skipped = 0;

/**
 * A test (or a whole fixture-gated block of them) that did NOT run.
 *
 * Registering nothing used to be indistinguishable from passing: a missing
 * fixture simply took the assertions out of the run and the summary reported a
 * silently smaller `passed`, which reads as success. Every skip is now named on
 * stdout AND carried into the tally, so "78 passed, 0 failed, 3 skipped" says
 * out loud that less was tested than the run claims to cover.
 */
function skip(name, reason) {
  console.log(`  \u23ed\ufe0f  SKIP ${name}`);
  console.log(`     ${reason}`);
  skipped++;
}

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

  try {
    const pre = api.buildPrePassOnce(bytes);
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

// ===== setSourceBytes + *FromSource (cold-load lever 1c) =====
// The whole file was memcpy'd into the wasm heap on EVERY processGeometryBatch*
// call (the wasm-bindgen `data: &[u8]` arg). setSourceBytes holds it ONCE and
// the *FromSource variants read it, so a huge model no longer pays 600+ full
// file copies/worker. The HARD gate is byte-identical output: the meshing reads
// the exact same bytes whether copied once or per call. These tests prove that
// at the real wasm boundary (mocked TS tests can't).
console.log('\n📋 setSourceBytes + *FromSource batch (byte-identical)');

/**
 * Byte-identical fingerprint of a MeshCollection: per-mesh identity + full
 * geometry arrays, in collection order. Copies out of wasm memory and frees
 * each MeshDataJs handle so the caller can free() the collection right after.
 */
function meshFingerprint(collection) {
  const meshes = [];
  for (let i = 0; i < collection.length; i++) {
    const m = collection.get(i);
    if (!m) continue;
    try {
      meshes.push({
        expressId: m.expressId,
        ifcType: m.ifcType,
        geometryClass: m.geometryClass,
        color: Array.from(m.color),
        origin: Array.from(m.origin),
        positions: Array.from(m.positions),
        normals: Array.from(m.normals),
        indices: Array.from(m.indices),
      });
    } finally {
      m.free();
    }
  }
  return meshes;
}

test('processGeometryBatchFromSource is byte-identical to processGeometryBatch', () => {
  const bytes = new TextEncoder().encode(columnContent);

  // Reference: the legacy per-call `data`-taking path.
  let ref;
  try {
    const preRef = api.buildPrePassOnce(bytes);
    const col = api.processGeometryBatch(
      bytes, preRef.jobs, preRef.unitScale,
      preRef.rtcOffset[0], preRef.rtcOffset[1], preRef.rtcOffset[2], preRef.needsShift,
      preRef.voidKeys, preRef.voidCounts, preRef.voidValues, preRef.styleIds, preRef.styleColors,
      preRef.planeAngleToRadians, preRef.materialElementIds, preRef.materialColorCounts, preRef.materialColors,
    );
    try { ref = meshFingerprint(col); } finally { col.free(); }
  } finally {
    api.clearPrePassCache();
  }
  assert.ok(ref.length > 0, 'reference batch must produce meshes');

  // Candidate: hold the source ONCE, run the no-`data` variant.
  let got;
  try {
    const pre = api.buildPrePassOnce(bytes);
    api.setSourceBytes(bytes);
    const col = api.processGeometryBatchFromSource(
      pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors,
    );
    try { got = meshFingerprint(col); } finally { col.free(); }
  } finally {
    api.clearPrePassCache();
  }

  assert.deepEqual(got, ref,
    'processGeometryBatchFromSource must be byte-for-byte identical to processGeometryBatch');
});

/** The 15-argument pre-pass tail both partitioned exports take, spelled ONCE.
 *  Three call sites carried a literal copy each, so a pre-pass field added or
 *  reordered had to be threaded through all three by hand and a miss would read
 *  as a geometry bug rather than a call-site bug. `pre` is a `buildPrePassOnce`
 *  result. The two exports stay separate calls on purpose — the test below
 *  exists to compare them. */
function partitionedArgs(pre) {
  return [
    pre.jobs, pre.unitScale,
    pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors,
  ];
}

/** `processGeometryBatchPartitioned` over a per-call `data` buffer. */
function callPartitioned(data, pre) {
  return api.processGeometryBatchPartitioned(data, ...partitionedArgs(pre));
}

test('processGeometryBatchPartitionedFromSource matches processGeometryBatchPartitioned', () => {
  if (typeof api.processGeometryBatchPartitioned !== 'function'
    || typeof api.processGeometryBatchPartitionedFromSource !== 'function') {
    throw new Error('partitioned exports missing from the built wasm');
  }
  const bytes = new TextEncoder().encode(columnContent);

  // Reference partitioned (legacy per-call data).
  let refFlat, refShard, refOcc;
  try {
    const preRef = api.buildPrePassOnce(bytes);
    const p = callPartitioned(bytes, preRef);
    try {
      refOcc = p.instancedOccurrences;
      refShard = Array.from(p.takeShard());
      const flat = p.takeMeshes();
      refFlat = flat ? meshFingerprint(flat) : [];
      if (flat) flat.free();
    } finally {
      p.free?.();
    }
  } finally {
    api.clearPrePassCache();
  }

  // Candidate partitioned FromSource (source held once).
  let gotFlat, gotShard, gotOcc;
  try {
    const pre = api.buildPrePassOnce(bytes);
    api.setSourceBytes(bytes);
    const p = api.processGeometryBatchPartitionedFromSource(...partitionedArgs(pre));
    try {
      gotOcc = p.instancedOccurrences;
      gotShard = Array.from(p.takeShard());
      const flat = p.takeMeshes();
      gotFlat = flat ? meshFingerprint(flat) : [];
      if (flat) flat.free();
    } finally {
      p.free?.();
    }
  } finally {
    api.clearPrePassCache();
  }

  assert.equal(gotOcc, refOcc, 'instanced occurrence count must match');
  assert.deepEqual(gotShard, refShard, 'IFNS instancing shard bytes must be identical');
  assert.deepEqual(gotFlat, refFlat, 'flat MeshCollection must be byte-identical');
});

// #2985: the item id at the REAL wasm boundary.
//
// The Rust-side coverage builds its `InstanceMeshRef`s by MIRRORING what
// `process_geometry_batch_partitioned` does, because that export is
// wasm_bindgen-only and cannot run natively — so a mirror can stay green while
// the production wiring one file over is wrong. This runs the real export
// against a real model and reads the ids straight out of the shard bytes, which
// is the only place the two can be compared without a mirror.
//
// Duplex is chosen because it HAS repeated mapped geometry: eight identical
// windows, each a multi-item source, so several templates share one product set
// and each template's item id is the thing that tells them apart. The
// instance-count assertion is what stops this going vacuous if a routing change
// empties the shard — zero instances would otherwise satisfy every `for` below.
if (LAYERED_AVAILABLE) {
  console.log('\n📋 #2985 instanced item id (wasm → wire)');

  test('the partitioned shard carries each occurrence\'s representation item', () => {
    const bytes = readFileSync(LAYERED_IFC);
    let shard;
    try {
      const pre = api.buildPrePassOnce(bytes);
      const p = callPartitioned(bytes, pre);
      try {
        shard = p.takeShard();
        const flat = p.takeMeshes();
        if (flat) flat.free();
      } finally {
        p.free?.();
      }
    } finally {
      api.clearPrePassCache();
    }

    assert.ok(shard.length >= 32, 'the shard must at least carry a header');
    const dv = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
    assert.equal(dv.getUint32(4, true), 2, 'the shipped encoder writes wire version 2');
    // Header word 7 is the instance record STRIDE IN BYTES: 88 for the base
    // record (templateIndex, entityId, colour, transform) plus 4 for trailing
    // field 1, the item id. The encoder writes 88 when no occurrence in the
    // batch names an item, so 92 here IS the claim that duplex's do.
    const stride = dv.getUint32(28, true);
    assert.equal(stride, 92, 'header word 7 must declare the 92-byte item-id stride');

    const templateCount = dv.getUint32(8, true);
    const instanceCount = dv.getUint32(12, true);
    assert.ok(instanceCount > 0, 'duplex must still produce instanced occurrences');
    const instanceTable = 32 + templateCount * 48;

    const perTemplate = new Map();
    for (let i = 0; i < instanceCount; i++) {
      const base = instanceTable + i * stride;
      const templateIndex = dv.getUint32(base, true);
      const entityId = dv.getUint32(base + 4, true);
      const itemId = dv.getUint32(base + 88, true);
      assert.notEqual(itemId, 0, `occurrence ${i} (#${entityId}) reports no item id`);
      // The two are different questions; equal means one is wired to the other.
      assert.notEqual(itemId, entityId, `occurrence ${i}'s item id is its own express id`);
      const seen = perTemplate.get(templateIndex);
      if (seen === undefined) perTemplate.set(templateIndex, itemId);
      else assert.equal(seen, itemId,
        `template ${templateIndex} reports two different item ids (${seen} vs ${itemId})`);
    }
    // Distinct templates come from distinct source items — that is what makes
    // the id worth carrying rather than derivable from the product.
    //
    // The equality below is VACUOUS on a one-template shard: a single entry is
    // trivially distinct from itself. Duplex's eight windows are multi-item, so
    // a collapse to one template is a regression, not a fixture quirk.
    assert.ok(perTemplate.size > 1,
      `need >1 template to prove ids differ ACROSS templates, got ${perTemplate.size}`);
    assert.equal(new Set(perTemplate.values()).size, perTemplate.size,
      'two templates share an item id; the id is not per representation item');
  });
} else {
  skip('#2985 instanced item id (wasm \u2192 wire)',
    `${LAYERED_IFC} missing \u2014 ${FIXTURES_HINT}`);
}

test('processGeometryBatchFromSource returns empty when no source is installed (defensive)', () => {
  const freshApi = new IfcAPI();
  const bytes = new TextEncoder().encode(columnContent);
  try {
    const pre = freshApi.buildPrePassOnce(bytes);
    // No setSourceBytes: the held bytes are empty → zero meshes, and crucially
    // NO panic (the decoder validates every byte span). The JS worker gates the
    // *FromSource path on a successful setSourceBytes, so this is unreachable in
    // production, but it must degrade gracefully rather than corrupt/crash.
    const col = freshApi.processGeometryBatchFromSource(
      pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      assert.equal(col.length, 0, 'FromSource without setSourceBytes must produce no meshes');
    } finally {
      col.free();
    }
  } finally {
    freshApi.clearPrePassCache();
    freshApi.free();
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
  try {
    const pre = api.buildPrePassOnce(bytes);
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
  try {
    const pre = api.buildPrePassOnce(bytes);
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
  try {
    const pre = api.buildPrePassOnce(bytes);
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

const GEOREF_METRE_TEST = 'unit scale resolves plain SI metres (georef fixture → 1.0)';
if (!GEOREF_AVAILABLE) skip(GEOREF_METRE_TEST, `${GEOREF_IFC} missing — ${FIXTURES_HINT}`);
else test(GEOREF_METRE_TEST, () => {
  const georefContent = readFileSync(GEOREF_IFC, 'utf-8');
  const bytes = new TextEncoder().encode(georefContent);
  try {
    const pre = api.buildPrePassOnce(bytes);
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

// exportGlbFromMeshes assembles a GLB straight from flattened mesh arrays (the viewer's
// GPU meshes) and fails closed on malformed counts — exercised HERE through the real wasm
// boundary, since the Rust-level tests can't prove the JS throw contract.
const fromMeshesGlb = api.exportGlbFromMeshes(
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
  new Uint32Array([3]), new Uint32Array([3]),
  new Float32Array([0.5, 0.5, 0.5, 1]), new Float64Array([0, 0, 0]), new Uint32Array([1]),
  false, true, false,
);

test('exportGlbFromMeshes returns a GLB for valid flattened meshes', () => {
  assert.ok(fromMeshesGlb instanceof Uint8Array && fromMeshesGlb.length > 20, 'valid meshes produce a GLB');
  assert.deepEqual(Array.from(fromMeshesGlb.slice(0, 4)), [0x67, 0x6c, 0x54, 0x46]); // "glTF"
});

test('exportGlbFromMeshes fails closed on malformed inputs (MALFORMED_MESH_INPUT)', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const fullNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const vc = new Uint32Array([3]);
  const color = new Float32Array([0.5, 0.5, 0.5, 1]);
  const origin = new Float64Array([0, 0, 0]);
  const ids = new Uint32Array([1]);
  const startsWithMalformed = (e) => e instanceof Error && e.message.startsWith('MALFORMED_MESH_INPUT');

  // Short normals (6 floats, mesh needs 9): the mesh would silently vanish.
  assert.throws(
    () => api.exportGlbFromMeshes(
      positions, new Float32Array([0, 0, 1, 0, 0, 1]), indices, vc, new Uint32Array([3]),
      color, origin, ids, false, true, false,
    ),
    startsWithMalformed,
    'short normals must throw MALFORMED_MESH_INPUT',
  );

  // Fewer index_counts than declared meshes (0 entries for 1 mesh).
  assert.throws(
    () => api.exportGlbFromMeshes(
      positions, fullNormals, indices, vc, new Uint32Array([]),
      color, origin, ids, false, true, false,
    ),
    startsWithMalformed,
    'missing index_counts must throw MALFORMED_MESH_INPUT',
  );
});

// ===== glTF spec conformance (Khronos glTF-Validator) =====
//
// Until this block existed, nothing anywhere in the repo checked our glTF
// against the *format*: the only reader of a GLB we write is our own
// `parseGLB` (`packages/export/src/glb.ts`), and a writer and a reader that
// agree with each other prove nothing about the spec — the same self-round-trip
// shape that hid live defects in other formats. `rust/export/src/gltf_tests.rs`
// even NAMES glTF-Validator in a comment describing what it would report,
// without ever invoking it.
//
// `gltf-validator` is the Khronos reference implementation, shipped as a
// self-contained Dart-to-JS bundle (~400 KB, no native deps, no network at
// runtime), so it runs right here on the bytes the REAL wasm exporter just
// produced. It is deliberately pinned to an exact version: the validator's
// output IS the assertion, and a floating range would let a new rule turn this
// lane red on unchanged output — or silently stop enforcing one.
console.log('\n📋 glTF conformance (Khronos glTF-Validator)');

async function validateGlb(bytes, uri) {
  return gltfValidator.validateBytes(new Uint8Array(bytes), {
    uri,
    maxIssues: 100,
    // Every buffer we emit is GLB-embedded. A request for an external resource
    // would itself be the defect (a URI the artifact cannot satisfy), so reject
    // rather than resolve one and let it surface as an unresolved-reference issue.
    externalResourceFunction: (u) =>
      Promise.reject(new Error(`unexpected external resource request: ${u}`)),
  });
}

/** Fail on ERROR (severity 0) *and* WARNING (severity 1), quoting the validator verbatim. */
function assertClean(report, label) {
  const { numErrors, numWarnings, messages } = report.issues;
  const detail = messages
    .filter((m) => m.severity <= 1)
    .map((m) => `\n       [${m.severity === 0 ? 'ERROR' : 'WARNING'}] ${m.code} ${m.pointer} :: ${m.message}`)
    .join('');
  assert.equal(
    numErrors + numWarnings,
    0,
    `${label}: glTF-Validator reported ${numErrors} error(s), ${numWarnings} warning(s):${detail}`,
  );
}

const glbReport = await validateGlb(glbBytes, 'exportGlb.glb');
const fromMeshesReport = await validateGlb(fromMeshesGlb, 'exportGlbFromMeshes.glb');

test('exportGlb output is spec-conformant glTF 2.0 (0 errors, 0 warnings)', () => {
  assertClean(glbReport, 'exportGlb');
});

// A clean report over an EMPTY artifact is the "check that cannot fail" trap:
// the validator is perfectly happy with a GLB that declares no geometry, so a
// silently-empty export would read as a pass above. Pin what it actually saw.
test('the validator saw real geometry, not a vacuously clean empty GLB', () => {
  assert.equal(glbReport.info.version, '2.0', 'asset.version');
  assert.ok(glbReport.info.drawCallCount > 0, `drawCallCount was ${glbReport.info.drawCallCount}`);
  assert.ok(
    glbReport.info.totalTriangleCount > 0,
    `totalTriangleCount was ${glbReport.info.totalTriangleCount}`,
  );
  assert.ok(
    glbReport.info.totalVertexCount >= 3,
    `totalVertexCount was ${glbReport.info.totalVertexCount}`,
  );
});

// The from-meshes entry point is a SEPARATE assembler (rust/export/src/gltf/from_meshes.rs)
// reachable from the viewer's `exportGlbFromMeshes`; validating only the
// from-bytes path would leave it as unvalidated as before.
test('exportGlbFromMeshes output is spec-conformant glTF 2.0 (0 errors, 0 warnings)', () => {
  assertClean(fromMeshesReport, 'exportGlbFromMeshes');
  assert.equal(fromMeshesReport.info.totalTriangleCount, 1, 'the one triangle handed in');
});

// ===== legacy keywords keep their type across the wasm boundary (#3179) =====
//
// The native pipeline resolves a legacy keyword through `legacy_entities.rs`
// and labels the node with its real base type. The BROWSER path did not: the
// jobs wire carries only (id, start, end), so `batch.rs` rebuilt the type from
// `entity.ifc_type` -- the decoder's bare `IfcType::from_str` -- and a legacy
// keyword that reached that path arrived as `Unknown` with the Unknown default
// colour. Not every keyword IFC4X3 dropped: an arm with `has_geometry: false`
// in `legacy_entities.rs` does not reach that path today, so this test does
// not cover those. #3187 carries the trace: which producers gate on the flag,
// and the type-geometry gate that does not.
//
// It is silent in the same way a wrong geometryClass is: the mesh renders, it
// is simply mislabelled, and type-exact visibility rules and styling quietly
// skip it. Nothing throws.
//
// This has to be checked HERE rather than in a Rust unit test, because the
// defect lived in the wasm binding specifically -- the native path was correct
// the whole time, so any test that did not cross the boundary agreed with the
// half that already worked.
console.log('\n📋 legacy keyword labelling (Rust → JS, #3179)');

test('a legacy keyword crosses as its resolved type, not "Unknown"', () => {
  // IFCCOLUMN is modern; IFCBEAMSTANDARDCASE is IFC4-removed and sits in
  // `legacy_entities.rs` mapping to IfcBeam. Respelling the fixture's columns
  // changes ONE keyword and nothing else, so the label is the only variable.
  const modern = columnContent;
  assert.ok(modern.includes('IFCCOLUMN('), 'fixture lost its columns — the respelling would test nothing');
  const legacy = modern.replace(/IFCCOLUMN\(/g, 'IFCBEAMSTANDARDCASE(');

  const collect = (content) => {
    const collection = parseMeshesViaPrePass(api, content);
    const types = [];
    for (let i = 0; i < collection.length; i++) {
      const m = collection.get(i);
      if (!m) continue;
      types.push(m.ifcType);
      m.free();
    }
    collection.free();
    return types;
  };

  const before = collect(modern);
  const after = collect(legacy);

  assert.ok(before.length > 0, 'the fixture must produce meshes, or this pins nothing');
  assert.equal(after.length, before.length, 'the respelling changed how many meshes are produced');
  // The RESOLVED type specifically, not merely "not Unknown", which any
  // other wrong label would also satisfy. The message prints the distinct
  // labels seen, so a regression to "Unknown" names itself.
  assert.ok(
    after.every((t) => t === 'IfcBeam'),
    `expected every mesh to label as IfcBeam, saw ${JSON.stringify([...new Set(after)])}`,
  );
});

// ===== geometryClass ordinals, pinned at the real boundary =====
//
// `packages/geometry/src/geometry-class.ts` names these ordinals for the
// TypeScript side, and its own test asserts them against literals. That test
// cannot fail if Rust starts emitting different numbers — both halves would
// simply agree with themselves, which is the self-round-trip trap.
//
// This is the other half: it reads what Rust ACTUALLY emits across the wasm
// boundary and pins the literal. `meshFingerprint` above also reads
// `geometryClass`, but only to compare two code paths against each other, so
// it is satisfied by any value as long as both paths produce the same one.
//
// A wrong ordinal is silent: geometry is reclassified rather than rejected, so
// a layered wall drops out of Model view, or a type-library duplicate renders
// as real building geometry, with nothing thrown anywhere.
if (LAYERED_AVAILABLE) {
  console.log('\n📋 geometryClass ordinals (Rust → TS contract)');
  const layeredContent = readFileSync(LAYERED_IFC, 'utf-8');

  test('a layered wall emits GEOM_CLASS_LAYER_SLICE === 3', () => {
    const collection = parseMeshesViaPrePass(api, layeredContent);
    const classes = new Set();
    for (let i = 0; i < collection.length; i++) {
      const m = collection.get(i);
      if (!m) continue;
      classes.add(m.geometryClass);
      m.free();
    }
    collection.free();

    // The literal 3 is the point. Deriving it from the TS constant would make
    // this agree with the thing it is supposed to be checking.
    assert.ok(
      classes.has(3),
      `expected a material-layer slice tagged 3; saw classes ${[...classes].sort().join(', ')}`,
    );
    // Placed occurrences must still be class 0 alongside them — if everything
    // came back 3, the assertion above would pass while the tagging was broken.
    assert.ok(
      classes.has(0),
      `expected placed occurrences tagged 0; saw classes ${[...classes].sort().join(', ')}`,
    );
  });
} else {
  skip('geometryClass ordinals (Rust \u2192 TS contract)',
    `${LAYERED_IFC} missing \u2014 ${FIXTURES_HINT}`);
}

// ===== source ids: representation item vs material layer (#3199) =====
//
// A mesh carries EITHER the `IfcRepresentationItem` it was tessellated from
// (`geometryItemId`) OR the `IfcMaterial` whose layer it slices
// (`materialId`), never both. Before #3199 both arrived in one field, so
// following it to source landed on an IfcMaterial for layered walls with
// nothing to warn the caller.
//
// These read the RAW `MeshCollection` rather than `parseMeshesViaPrePass`,
// because only the raw handle can be read both ways.
//
// The facade is pinned too, separately and deliberately: it mirrors
// `convertMeshCollectionToBatch` field by field, and it DID silently drop both
// ids when they were added — my first probe read zeros through it and reported
// the boundary broken when the boundary was fine. A field the real converter
// carries and that facade drops is invisible to every script that reads through
// it, so one test below reads through the facade on purpose.
//
// Wrong ids here are silent in the usual way: geometry renders identically and
// only a host that follows the id to source sees it land on the wrong entity.
if (LAYERED_AVAILABLE) {
  console.log('\n📋 source ids: representation item vs material layer (#3199)');
  const layeredContent = readFileSync(LAYERED_IFC, 'utf-8');

  // The real `MeshCollection`, handles and all. Callers must free.
  const rawCollection = (content) => {
    const bytes = new TextEncoder().encode(content);
    try {
      const pre = api.buildPrePassOnce(bytes);
      const rtc = (pre && pre.rtcOffset) || [0, 0, 0];
      return api.processGeometryBatch(
        bytes, pre.jobs, pre.unitScale, rtc[0] || 0, rtc[1] || 0, rtc[2] || 0, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      );
    } finally {
      if (api.clearPrePassCache) api.clearPrePassCache();
    }
  };

  /** Read every mesh's ids out of a fresh collection, freeing as we go. */
  const readIds = (content) => {
    const col = rawCollection(content);
    const rows = [];
    try {
      for (let i = 0; i < col.length; i++) {
        const m = col.get(i);
        if (!m) continue;
        try {
          rows.push({
            expressId: m.expressId,
            geometryClass: m.geometryClass,
            geometryItemId: m.geometryItemId,
            materialId: m.materialId,
          });
        } finally {
          m.free();
        }
      }
    } finally {
      col.free();
    }
    return rows;
  };

  // The unedited fixture is read ONCE and shared: `readIds` is deterministic
  // and every test below that passes `layeredContent` was re-running the whole
  // pre-pass + geometry batch over a 2.4 MB file to get the same rows back.
  // Tests that MUTATE the fixture still take their own run, since that is the
  // variable they are measuring.
  let layeredRowsMemo = null;
  const layeredRows = () => (layeredRowsMemo ??= readIds(layeredContent));

  test('every mesh carries exactly one source id, never both and never neither', () => {
    const rows = layeredRows();
    assert.ok(rows.length > 0, 'the fixture produced no meshes, so nothing below is pinned');
    const both = rows.filter((r) => r.geometryItemId !== undefined && r.materialId !== undefined);
    const neither = rows.filter((r) => r.geometryItemId === undefined && r.materialId === undefined);
    assert.equal(both.length, 0, `${both.length} mesh(es) carry BOTH ids, e.g. #${both[0]?.expressId}`);
    // "Neither" is a legitimate state elsewhere (the single-mesh fallback, the
    // cached mapped-item path). It must not happen on THIS fixture, whose
    // elements all go through the submesh channel — if it starts happening,
    // the ids stopped crossing the boundary and the checks below go vacuous.
    assert.equal(neither.length, 0, `${neither.length} mesh(es) carry NO id, e.g. #${neither[0]?.expressId}`);
  });

  test('a two-item element carries a distinct geometryItemId per piece, and no material id', () => {
    const rows = layeredRows();
    const byElement = new Map();
    for (const r of rows) {
      if (r.geometryItemId === undefined) continue;
      let ids = byElement.get(r.expressId);
      if (!ids) byElement.set(r.expressId, (ids = new Set()));
      ids.add(r.geometryItemId);
    }
    const multi = [...byElement.entries()].filter(([, ids]) => ids.size >= 2);
    assert.ok(
      multi.length > 0,
      'no element produced two distinct geometryItemIds — either the fixture stopped ' +
        'producing multi-item elements, or every piece is being stamped with the same id',
    );
    // An express id, not a slot index: 0 is never a valid STEP instance name.
    for (const [, ids] of byElement) {
      for (const id of ids) {
        assert.ok(Number.isInteger(id) && id > 0, `geometryItemId ${id} is not a plausible express id`);
      }
    }
    // The pieces of a multi-item element are representation items, so none of
    // them may also claim to be a material layer.
    const multiIds = new Set(multi.map(([expressId]) => expressId));
    const stray = rows.filter((r) => multiIds.has(r.expressId) && r.materialId !== undefined);
    assert.equal(stray.length, 0, `a multi-item element also reported a materialId: #${stray[0]?.expressId}`);
  });

  test('a material-layered wall reports materialId, and geometryItemId undefined', () => {
    const rows = layeredRows();
    const sliced = rows.filter((r) => r.materialId !== undefined);
    assert.ok(sliced.length > 0, 'no mesh carried a materialId — the layer slicer did not run');
    for (const r of sliced) {
      assert.equal(
        r.geometryItemId, undefined,
        `#${r.expressId} carries a materialId AND a geometryItemId`,
      );
      // A slice is layer geometry, so it must also be tagged class 3.
      assert.equal(r.geometryClass, 3, `#${r.expressId} carries a materialId at class ${r.geometryClass}`);
    }
  });

  test('geometryClass 3 does NOT imply a material id: a bailed slice keeps its item id', () => {
    // The contract clause most likely to be "simplified" away later, so it gets
    // its own executable pin.
    //
    // geometryClass is stamped from `is_material_layer_sliceable`, a STATIC
    // check on the material index made before any geometry runs.
    // `try_layered_sub_meshes` can still bail at runtime (the cut produced
    // fewer than two slabs, a void CSG errored) and fall through to the
    // representation-item path — under class 3. Deriving which id a mesh
    // carries from geometryClass would therefore hand back an IfcMaterial id
    // for meshes whose id is an IfcRepresentationItem: the exact confusion
    // #3199 removed, reintroduced one refactor later.
    const rows = layeredRows();
    const classThree = rows.filter((r) => r.geometryClass === 3);
    assert.ok(classThree.length > 0, 'no class-3 meshes at all — this pins nothing');
    const bailed = classThree.filter((r) => r.geometryItemId !== undefined);
    assert.ok(
      bailed.length > 0,
      'every class-3 mesh carried a materialId, so this fixture can no longer ' +
        'distinguish "the flag comes from the collection" from "the flag is derived ' +
        'from geometryClass" — find a fixture whose layer slicing bails at runtime',
    );
    for (const r of bailed) {
      assert.equal(r.materialId, undefined, `#${r.expressId} carries both ids`);
    }
  });

  test('an air-gap layer reports NO material, not IfcMaterial #0', () => {
    // `IfcMaterialLayer.Material` is OPTIONAL, and `material_layer_index.rs`
    // decodes an absent one as `get_ref(0).unwrap_or(0)` -- so 0 is that
    // function's "no reference" SENTINEL, not an entity. STEP instance names
    // start at #1, so `#0` is not navigable, and following it is the one thing
    // this field exists for.
    //
    // Dropping the Material ref from one layer of the real fixture changes ONE
    // token and nothing else, so the id is the only variable.
    //
    // The first version of #3199 shipped this as `materialId: 0` on the theory
    // that 0 was a real value which must round trip. It is not; preserving a
    // producer's absence sentinel as data is the same defect the change exists
    // to remove, one field over.
    const withMaterial = /IFCMATERIALLAYER\(#3876,/g;
    assert.ok(
      withMaterial.test(layeredContent),
      'the fixture no longer has the layer this test edits — pick another IFCMATERIALLAYER',
    );
    const airGap = layeredContent.replace(withMaterial, 'IFCMATERIALLAYER($,');

    const before = layeredRows().filter((r) => r.materialId === 3876);
    assert.ok(before.length > 0, 'material #3876 sliced no layers, so the edit below proves nothing');

    const after = readIds(airGap).filter((r) => r.geometryClass === 3);

    // 1. The removed material is gone.
    assert.ok(
      !after.some((r) => r.materialId === 3876),
      'a slice still reports the material id that was removed from the file',
    );

    // 2. It did not come back as 0. This is the assertion the fix is about, and
    //    it fails loudly against the pre-fix build: those same slices carried
    //    `materialId: 0` there.
    const zeros = after.filter((r) => r.materialId === 0);
    assert.equal(
      zeros.length, 0,
      `${zeros.length} air-gap slice(s) reported IfcMaterial #0, which is not an entity ` +
        `(e.g. #${zeros[0]?.expressId})`,
    );

    // 3. And the slices still EXIST, unattributed rather than dropped —
    //    otherwise 1 and 2 are satisfied by the geometry disappearing, which
    //    would be a far worse bug wearing this test as cover.
    const unattributed = after.filter(
      (r) => r.materialId === undefined && r.geometryItemId === undefined,
    );
    assert.ok(
      unattributed.length >= before.length,
      `dropping the material ref should leave ${before.length} slice(s) present but ` +
        `unattributed, saw ${unattributed.length}`,
    );

    // 4. And nothing silently migrated to the other field.
    for (const r of unattributed) {
      assert.equal(
        r.geometryItemId, undefined,
        `air-gap slice #${r.expressId} adopted a geometryItemId instead of reporting nothing`,
      );
    }
  });

  test('the prepass FACADE carries both ids, not just the raw collection', () => {
    // This is the test the block header promises, and it exists because the
    // facade is where this actually went wrong: `scripts/lib/mesh-via-prepass.mjs`
    // mirrors `convertMeshCollectionToBatch` field by field, it did NOT copy the
    // new ids, and my first probe read zeros through it and reported the wasm
    // boundary broken when the boundary was fine.
    //
    // Every other test in this block reads the raw `MeshCollection`, which is
    // UPSTREAM of the facade — so without this one the facade edit ships with no
    // coverage at all, and a future field dropped there is invisible to every
    // script that reads through it.
    const meshes = parseMeshesViaPrePass(api, layeredContent);
    let items = 0, materials = 0, both = 0;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes.get(i);
      if (!m) continue;
      const hasItem = m.geometryItemId !== undefined && m.geometryItemId !== null;
      const hasMaterial = m.materialId !== undefined && m.materialId !== null;
      if (hasItem && hasMaterial) both++;
      else if (hasItem) items++;
      else if (hasMaterial) materials++;
      if (m.free) m.free();
    }
    if (meshes.free) meshes.free();

    // Cross-check against the raw collection rather than against a fixed number:
    // this asserts the facade agrees with the boundary, which is the actual
    // contract, and it cannot go vacuous if the fixture changes.
    const raw = layeredRows();
    assert.equal(
      items, raw.filter((r) => r.geometryItemId !== undefined).length,
      'the facade dropped or invented geometryItemId relative to the raw collection',
    );
    assert.equal(
      materials, raw.filter((r) => r.materialId !== undefined).length,
      'the facade dropped or invented materialId relative to the raw collection',
    );
    assert.equal(both, 0, `${both} mesh(es) carried BOTH ids through the facade`);
    assert.ok(items > 0 && materials > 0, `non-vacuity: items=${items} materials=${materials}`);
  });

  test('takeMesh reports the same ids as get, and stays read-once', () => {
    // The worker reads meshes with takeMesh and the main thread with get. Both
    // now go through the derived Clone, so they can no longer disagree by
    // construction -- what this still pins is that `from_mesh_data` wires the
    // ids onto the struct at all, which no amount of deriving guarantees.
    const viaGet = layeredRows();

    const col = rawCollection(layeredContent);
    const viaTake = [];
    try {
      for (let i = 0; i < col.length; i++) {
        const m = col.takeMesh(i);
        if (!m) continue;
        try {
          viaTake.push({
            expressId: m.expressId,
            geometryItemId: m.geometryItemId,
            materialId: m.materialId,
            vertexCount: m.vertexCount,
          });
        } finally {
          m.free();
        }
      }

      assert.equal(viaTake.length, viaGet.length, 'takeMesh and get disagree on how many meshes there are');
      for (let i = 0; i < viaTake.length; i++) {
        assert.equal(viaTake[i].expressId, viaGet[i].expressId, `mesh ${i}: express ids diverged`);
        assert.equal(
          viaTake[i].geometryItemId, viaGet[i].geometryItemId,
          `mesh ${i} (#${viaGet[i].expressId}): takeMesh geometryItemId disagrees with get`,
        );
        assert.equal(
          viaTake[i].materialId, viaGet[i].materialId,
          `mesh ${i} (#${viaGet[i].expressId}): takeMesh materialId disagrees with get`,
        );
      }
      assert.ok(viaTake.some((r) => r.vertexCount > 0), 'the first take returned no geometry at all');

      // Read-once: takeMesh MOVES the whole struct out, so a second call for the
      // same index yields a DEFAULT mesh -- expressId 0, no ids, no geometry.
      //
      // This assertion used to permit either that or the old metadata-bearing
      // husk, because the ids were Copy and rode along by field assignment. Its
      // comment said a switch to `mem::take` on the whole struct would change
      // what a second call reports and that this suite should be the thing that
      // notices. That switch has now happened, so the permissive form is spent
      // and the exact behaviour is pinned instead: a test that accepts both
      // answers cannot report which one it got.
      // Non-vacuity: `expressId === 0` below only means anything while mesh 0
      // has a non-zero id to lose. A fixture swap could make it trivially true.
      assert.notEqual(viaTake[0].expressId, 0, 'fixture mesh 0 has no express id to lose');
      const again = col.takeMesh(0);
      assert.ok(again, 'a second takeMesh returned nothing at all');
      try {
        assert.equal(again.vertexCount, 0, 'a second takeMesh still returned vertex data');
        assert.equal(again.expressId, 0, 'a second takeMesh should report a default expressId');
        for (const field of ['geometryItemId', 'materialId']) {
          assert.equal(
            again[field], undefined,
            `a second takeMesh should report no ${field}, got ${again[field]}`,
          );
        }
      } finally {
        again.free();
      }
    } finally {
      col.free();
    }
  });
} else {
  skip('source ids: representation item vs material layer (#3199)',
    `${LAYERED_IFC} missing — ${FIXTURES_HINT}`);
}

// ===== energy-model boundary (exportHbjson / exportDfjson) =====
//
// The TypeScript suites mock `GeometryProcessor`, so they cannot catch a
// binding that is missing from the built runtime or returns the wrong shape.
// These call the real wasm boundary.
if (SPACES_AVAILABLE) {
  console.log('\n📋 energy model (exportHbjson / exportDfjson)');
  // Read as BYTES, never through a UTF-8 string. STEP/IFC files are routinely
  // ISO-8859-1, and decoding one as UTF-8 turns every invalid sequence into U+FFFD
  // — which `TextEncoder.encode` then re-emits as 3 different bytes (0xFC 'ü'
  // becomes EF BF BD), changing both the content and the length. Handing that to a
  // REAL-boundary contract test defeats its whole purpose. `readFileSync` without
  // an encoding already returns a Buffer, which is a Uint8Array.
  const spacesBytes = new Uint8Array(readFileSync(SPACES_IFC));

  test('exportDfjson returns a Dragonfly Model JSON string across the real boundary', () => {
    const raw = api.exportDfjson(spacesBytes, 'contract-df');
    assert.equal(typeof raw, 'string', 'DFJSON should cross the boundary as a string');
    const model = JSON.parse(raw);
    assert.equal(model.type, 'Model', 'top-level type discriminator');
    assert.equal(model.units, 'Meters');
    assert.equal(model.identifier, 'contract-df', 'the supplied name rides through');
    assert.ok(Array.isArray(model.buildings), 'buildings must be an array');
    const room2ds = model.buildings.flatMap((b) => (b.unique_stories ?? []).flatMap((s) => s.room_2ds ?? []));
    assert.ok(room2ds.length > 0, 'the spaces fixture must yield Room2Ds, else the per-room checks below are vacuous');
    assert.ok(typeof model.version === 'string' && model.version.length > 0);
    // Every emitted Room2D must carry the fields Dragonfly requires; a plate
    // with a missing height or an empty boundary is schema-invalid downstream.
    for (const b of model.buildings) {
      for (const s of b.unique_stories ?? []) {
        assert.equal(s.type, 'Story');
        for (const r of s.room_2ds ?? []) {
          assert.equal(r.type, 'Room2D');
          assert.ok(Array.isArray(r.floor_boundary) && r.floor_boundary.length >= 3);
          assert.ok(Number.isFinite(r.floor_height), 'floor_height must be finite');
          assert.ok(Number.isFinite(r.floor_to_ceiling_height) && r.floor_to_ceiling_height > 0);
        }
      }
    }
  });

  test('exportHbjson returns Honeybee JSON bytes across the real boundary', () => {
    const out = api.exportHbjson(spacesBytes, 'contract-hb');
    assert.ok(out instanceof Uint8Array, 'HBJSON should cross the boundary as bytes');
    const model = JSON.parse(new TextDecoder().decode(out));
    assert.ok(Array.isArray(model.rooms), 'Honeybee model must declare a rooms array');
  });
} else {
  skip('energy model (exportHbjson / exportDfjson)',
    `${SPACES_IFC} missing — ${FIXTURES_HINT}`);
}

test('exportKmz packs a stored-zip KMZ (PK header, doc.kml + model.glb, axis-derived heading)', () => {
  const kmz = api.exportKmz(glbBytes, 47.5, 8.5, 412, 1, 0, 'Contract Bldg');
  assert.ok(kmz instanceof Uint8Array, 'KMZ should be a Uint8Array');
  assert.deepEqual(Array.from(kmz.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
  const text = Buffer.from(kmz).toString('latin1');
  assert.ok(text.includes('doc.kml'), 'archive names doc.kml');
  assert.ok(text.includes('model.glb'), 'archive names model.glb');
  assert.ok(text.includes('<heading>0</heading>'), 'heading derived from grid axis (1,0) → 0');
  assert.ok(text.includes('Contract Bldg'), 'placemark name present');
});

test('exportKmz accepts undefined optional grid axes at the JS boundary (heading 0)', () => {
  // Exercises the Rust Option<f64> params as `undefined` (the shim detail Codex flagged).
  const kmz = api.exportKmz(glbBytes, 0, 0, 0, undefined, undefined, '');
  assert.ok(kmz instanceof Uint8Array);
  assert.ok(Buffer.from(kmz).toString('latin1').includes('<heading>0</heading>'), 'undefined axes → heading 0');
});

// ===== OpenUSD (.usda) export boundary =====
// The vitest suites all MOCK the wasm boundary (AGENTS.md §Geometry & WASM), so
// this is the real-WASM assertion for IfcAPI.exportUsd. hello-wall is git-tracked
// (unlike tests/models/*), so the export runs on any checkout with a built runtime.
const HELLO_WALL = join(ROOT_DIR, 'apps/landing/samples/hello-wall.ifc');
if (existsSync(HELLO_WALL)) {
  const wallBytes = new Uint8Array(readFileSync(HELLO_WALL));
  const usdBytes = api.exportUsd(wallBytes);
  const usda = usdBytes instanceof Uint8Array ? new TextDecoder().decode(usdBytes) : '';

  test('exportUsd returns a real Z-up USDA stage (/World, meshes, IFC metadata) with no non-finite coords', () => {
    assert.ok(usdBytes instanceof Uint8Array, 'USD should be a Uint8Array');
    assert.ok(usdBytes.length > 100, 'USD should be non-trivial');
    assert.ok(usda.startsWith('#usda 1.0'), 'starts with the USDA magic line');
    assert.match(usda, /upAxis\s*=\s*"Z"/, 'Z-up stage');
    assert.match(usda, /metersPerUnit\s*=\s*1/, 'metres (no scale conversion)');
    assert.ok(usda.includes('def Xform "World"'), 'has the /World root Xform');
    assert.match(usda, /def Mesh "|class Mesh "/, 'authored at least one mesh or prototype');
    assert.match(usda, /point3f\[\] points =/, 'meshes carry local points');
    assert.ok(usda.includes('ifc:class'), 'carries IFC metadata as custom attributes');
    // The IFC source must cross the boundary as real bytes: an empty input would
    // still yield a structurally valid header but zero geometry — caught above.
    // Rust gates non-finite coords out of the stage; assert none slipped through.
    assert.ok(!/(?<![A-Za-z])(nan|-?inf)(?![A-Za-z])/i.test(usda), 'no NaN/Inf tokens in the stage');
  });

  test('exportUsd is deterministic (byte-identical across two calls on the same input)', () => {
    const again = api.exportUsd(wallBytes);
    assert.ok(again instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(again), usda, 'USD export must be deterministic');
  });

  // ===== IFCX header, across the language boundary =====
  // The Rust exporter and the TypeScript writers each hold their own copy of
  // the version value (`IFCX_VERSION` in rust/export/src/ifc5.rs, and in
  // @ifc-lite/data re-exported by @ifc-lite/ifcx). Nothing else would notice
  // them drifting: `parseIfcx` accepts any value containing the substring
  // `ifcx`, case-insensitively, which is exactly why six call sites said
  // `ifcx_alpha` and a seventh said `IFCX-1.0` for months without a symptom.
  //
  // Pinned to the literal rather than imported: this script runs on plain node
  // against the built wasm, and asserting "Rust used its own constant" would
  // pass even if that constant changed. Update BOTH sides and this line.
  test('exportIfcx stamps the agreed header.ifcxVersion (pins Rust to the TS constant)', () => {
    const ifcxBytes = api.exportIfcx(wallBytes);
    assert.ok(ifcxBytes instanceof Uint8Array, 'IFCX should be a Uint8Array');
    const header = JSON.parse(new TextDecoder().decode(ifcxBytes)).header;
    assert.equal(header.ifcxVersion, 'ifcx_alpha', 'Rust exporter and @ifc-lite/data must agree');
    // The key itself, not just its value: writing it under `version` is what
    // made every exported file unreadable by our own parser until #2556.
    assert.ok(!('version' in header), 'the pre-#2556 `version` key must not come back');
  });
} else {
  skip('export contracts (USD / IFCX) over hello-wall',
    `apps/landing/samples/hello-wall.ifc missing — ${FIXTURES_HINT}`);
}

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
    diagApi.free();
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
    entityIdxApi.free();
  }
});

// ===== geometry-diff hashes + world AABB (issue #1891) =====
// Mocked-wasm tests cannot see any of this: the JS member name, the typed-array
// type, the 6-per-id stride, and above all the COORDINATE FRAME are all facts
// about the real binding. The hasher accumulates in the producer's IFC Z-up
// frame while every mesh crossing this boundary is Y-up, so a box that skipped
// the swap would look perfectly well-formed and simply fail to contain its own
// element's vertices.
console.log('\n📋 geometry-diff hashes + world AABB');

/**
 * Run one hashed batch over `content` and hand the caller the live collection.
 * `tolerance` is the geometry-hash quantization grid in metres; passing null
 * disables hashing (which is what makes the "off ⇒ empty" case testable).
 */
function withHashedBatch(content, tolerance, fn) {
  const hashApi = new IfcAPI();
  hashApi.setComputeGeometryHashes(tolerance);
  const bytes = new TextEncoder().encode(content);
  try {
    const pre = hashApi.buildPrePassOnce(bytes);
    assert.ok(pre.totalJobs > 0, 'fixture must produce geometry jobs');
    const col = hashApi.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      return fn(col);
    } finally {
      col.free();
    }
  } finally {
    // clearPrePassCache drops the load-scoped caches; free() drops the wasm
    // instance itself. Only the second one reclaims the linear-memory the
    // IfcAPI holds, and this helper builds a fresh one per invocation.
    hashApi.clearPrePassCache();
    hashApi.free();
  }
}

test('geometryAabbValues is a Float64Array of exactly 6 values per hashed id', () => {
  withHashedBatch(columnContent, 1e-3, (col) => {
    const ids = col.geometryHashIds;
    assert.ok(ids.length > 0, 'hashing on must fingerprint at least one entity');
    assert.equal(col.geometryHashCount, ids.length, 'count must match the id array');

    const aabb = col.geometryAabbValues;
    assert.ok(aabb instanceof Float64Array,
      `geometryAabbValues must be a Float64Array, got ${aabb && aabb.constructor && aabb.constructor.name}`);
    assert.equal(aabb.length, 6 * col.geometryHashCount,
      'six values per hashed id — a shorter array would mis-attribute every later box');
    assert.ok(aabb.every(Number.isFinite),
      'every hashed entity in this fixture produced real geometry, so no NaN spans');
    for (let i = 0; i < col.geometryHashCount; i++) {
      for (let k = 0; k < 3; k++) {
        assert.ok(aabb[6 * i + k] <= aabb[6 * i + 3 + k],
          `box ${i} axis ${k}: min ${aabb[6 * i + k]} must not exceed max ${aabb[6 * i + 3 + k]}`);
      }
    }
  });
});

// THE frame assertion. The exposed box is absolute world in the viewer's Y-up
// frame; mesh positions are RTC-relative and local-frame-relative in that same
// frame. So world = origin + position + S(rtcOffset), where S is the same
// Z-up→Y-up swap (x, y, z) -> (x, z, -y) the RTC offset itself has NOT had
// applied (it is reported in the IFC frame, see coordinate-handler.ts).
// Skipping the swap on the box makes this fail: a Z-up box has the element's
// height on its Z axis while the Y-up mesh carries it on Y.
test('geometryAabbValues is in the viewer frame and encloses its own meshes', () => {
  withHashedBatch(columnContent, 1e-3, (col) => {
    const ids = col.geometryHashIds;
    const aabb = col.geometryAabbValues;
    assert.ok(ids.length > 0, 'need at least one hashed entity to compare against');

    // Y-up RTC: the collection reports it in IFC Z-up, like the mesher consumed it.
    const rtc = [col.rtcOffsetX, col.rtcOffsetZ, -col.rtcOffsetY];

    // Measured extent of every mesh, per express id, in world Y-up.
    const measured = new Map();
    for (let i = 0; i < col.length; i++) {
      const mesh = col.get(i);
      if (!mesh) continue;
      try {
        const o = mesh.origin;
        const p = mesh.positions;
        let box = measured.get(mesh.expressId);
        if (!box) {
          box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          measured.set(mesh.expressId, box);
        }
        // Only INDEXED vertices, because that is exactly the corner set the
        // hasher walked (it iterates triangles, not the position buffer).
        for (const vi of mesh.indices) {
          const base = vi * 3;
          if (base + 2 >= p.length) continue;
          for (let k = 0; k < 3; k++) {
            const w = p[base + k] + (o ? o[k] : 0) + rtc[k];
            if (w < box[k]) box[k] = w;
            if (w > box[3 + k]) box[3 + k] = w;
          }
        }
      } finally {
        mesh.free();
      }
    }

    let compared = 0;
    for (let i = 0; i < ids.length; i++) {
      const box = measured.get(ids[i]);
      if (!box) continue; // hashed but not in this collection's flat meshes
      compared++;
      const extent = Math.max(
        box[3] - box[0], box[4] - box[1], box[5] - box[2], 1,
      );
      // f32 vertices reconstructed to f64 by both sides with the same terms, so
      // the only slack is f64 summation order.
      const eps = 1e-6 * extent;
      for (let k = 0; k < 3; k++) {
        assert.ok(aabb[6 * i + k] <= box[k] + eps,
          `id ${ids[i]} axis ${k}: exposed min ${aabb[6 * i + k]} must not cut into the mesh min ${box[k]}`);
        assert.ok(aabb[6 * i + 3 + k] >= box[3 + k] - eps,
          `id ${ids[i]} axis ${k}: exposed max ${aabb[6 * i + 3 + k]} must not cut into the mesh max ${box[3 + k]}`);
      }
      // Tight, not merely enclosing: the hasher sees exactly these vertices, so
      // a box inflated by a bad conversion (or by mixing frames) is also wrong.
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(aabb[6 * i + k] - box[k]) <= eps,
          `id ${ids[i]} axis ${k}: exposed min ${aabb[6 * i + k]} must equal the mesh min ${box[k]}`);
        assert.ok(Math.abs(aabb[6 * i + 3 + k] - box[3 + k]) <= eps,
          `id ${ids[i]} axis ${k}: exposed max ${aabb[6 * i + 3 + k]} must equal the mesh max ${box[3 + k]}`);
      }
    }
    assert.ok(compared > 0, 'at least one hashed id must have meshes in the collection to compare');
  });
});

// ===== Per-entity volume + closure (#1993), consumed by the split/merge
// detector in @ifc-lite/diff. The contract that matters downstream is not the
// number itself but WHEN there is one: a value exists exactly where the mesher
// proved a single closed orientable solid, and `NaN` means "not proved", never
// "zero".
test('geometryVolumeValues is a Float64Array of exactly one value per hashed id', () => {
  withHashedBatch(columnContent, 1e-3, (col) => {
    const volumes = col.geometryVolumeValues;
    assert.ok(volumes instanceof Float64Array,
      `geometryVolumeValues must be a Float64Array, got ${volumes && volumes.constructor && volumes.constructor.name}`);
    assert.equal(volumes.length, col.geometryHashCount,
      'one value per hashed id — a shorter array would mis-attribute every later volume');
    for (let i = 0; i < volumes.length; i++) {
      assert.ok(Number.isNaN(volumes[i]) || volumes[i] > 0,
        `volume ${i} is ${volumes[i]}: the only two legal states are a positive number and the NaN "not proved" sentinel`);
    }
  });
});

test('a volume is present exactly where geometryClosureFlags says 0x0F', () => {
  withHashedBatch(columnContent, 1e-3, (col) => {
    const volumes = col.geometryVolumeValues;
    const flags = col.geometryClosureFlags;
    assert.ok(flags instanceof Uint8Array,
      'geometryClosureFlags must be a Uint8Array');
    assert.equal(flags.length, col.geometryHashCount, 'one byte per hashed id');
    for (let i = 0; i < volumes.length; i++) {
      // The two arrays are the claim and its justification. If they can come
      // apart, a consumer reading a volume has no way to know it was proved.
      assert.equal(!Number.isNaN(volumes[i]), flags[i] === 0x0f,
        `id ${col.geometryHashIds[i]}: volume ${volumes[i]} vs closure flags 0x${flags[i].toString(16)}`);
    }
  });
});

test('a proved volume never exceeds the volume of its own world box', () => {
  // Cross-checks the two channels against each other, which is what makes a
  // unit slip (mm³ read as m³ is 1e9 too large) or a swapped index visible:
  // a closed solid cannot enclose more than its own bounding box.
  withHashedBatch(columnContent, 1e-3, (col) => {
    const volumes = col.geometryVolumeValues;
    const aabb = col.geometryAabbValues;
    let proved = 0;
    for (let i = 0; i < volumes.length; i++) {
      if (Number.isNaN(volumes[i])) continue;
      proved++;
      const boxVolume =
        (aabb[6 * i + 3] - aabb[6 * i]) *
        (aabb[6 * i + 4] - aabb[6 * i + 1]) *
        (aabb[6 * i + 5] - aabb[6 * i + 2]);
      assert.ok(volumes[i] <= boxVolume * (1 + 1e-9),
        `id ${col.geometryHashIds[i]}: volume ${volumes[i]} m³ exceeds its box volume ${boxVolume} m³`);
    }
    assert.ok(proved > 0,
      'this fixture is a closed extruded column — at least one entity must carry a proved volume, or the check above proved nothing');
  });
});

test('geometryVolumeValues is empty when setComputeGeometryHashes is off', () => {
  withHashedBatch(columnContent, null, (col) => {
    assert.equal(col.geometryVolumeValues.length, 0,
      'the volume rides the same switch as the hash and the box');
    assert.equal(col.geometryClosureFlags.length, 0,
      'and so does its justification');
  });
});

test('geometryAabbValues is empty when setComputeGeometryHashes is off', () => {
  withHashedBatch(columnContent, null, (col) => {
    assert.equal(col.geometryHashCount, 0, 'hashing off ⇒ no fingerprints');
    assert.equal(col.geometryAabbValues.length, 0,
      'the box rides the same switch — nothing is computed when the diff feature is off');
  });
});

// ===== 2D boolean contour sets (issue #1863) =====
console.log('\n📋 2D boolean contour sets');

/** CCW axis-aligned rectangle as a flat ring. */
function rectCcw(x0, y0, x1, y1) {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/** Build a Contours2D from an array of flat rings. */
function contours(...rings) {
  const coords = Float64Array.from(rings.flat());
  const lengths = Uint32Array.from(rings.map((r) => r.length / 2));
  return new Contours2D(coords, lengths);
}

/**
 * Covered area read back ACROSS the boundary: sum of signed ring areas, which
 * is the total only because winding carries outer-vs-hole. If the boundary ever
 * normalised winding, holes would start adding area and this would catch it.
 */
function coveredArea(set) {
  const coords = set.coords();
  const lengths = set.ringLengths();
  let at = 0;
  let total = 0;
  for (const n of lengths) {
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += coords[(at + i) * 2] * coords[(at + j) * 2 + 1]
        - coords[(at + j) * 2] * coords[(at + i) * 2 + 1];
    }
    total += a / 2;
    at += n;
  }
  return total;
}

test('Contours2D rejects coords that disagree with ringLengths', () => {
  assert.throws(
    () => new Contours2D(Float64Array.from(rectCcw(0, 0, 1, 1)), Uint32Array.from([5])),
    /ringLengths/,
    'a length mismatch must throw, not silently truncate the ring',
  );
});

test('the constructor drops degenerate rings so accessors stay consistent', () => {
  // A raw set built from a soup must not report state a later boolean would
  // disagree with: an all-degenerate input is empty, and isEmpty must agree
  // with bounds() (a 2-vertex ring is not "one ring" that bounds() can't cover).
  const coords = Float64Array.from([
    ...[0, 0, 1, 0], // 2-vertex ring — degenerate
    ...rectCcw(0, 0, 1, 1), // one real ring
  ]);
  const set = new Contours2D(coords, Uint32Array.from([2, 4]));
  try {
    assert.equal(set.ringCount, 1, 'the 2-vertex ring must be dropped');
    assert.equal(set.isEmpty, false);
    assert.ok(Math.abs(coveredArea(set) - 1) < 1e-9);
  } finally {
    set.free();
  }

  const empty = new Contours2D(Float64Array.from([0, 0, 1, 0]), Uint32Array.from([2]));
  try {
    assert.equal(empty.ringCount, 0, 'an all-degenerate set holds no rings');
    assert.equal(empty.isEmpty, true, 'isEmpty must agree with the dropped ring');
    assert.equal(empty.bounds(), undefined, 'bounds() must agree with isEmpty');
  } finally {
    empty.free();
  }

  // A 3-vertex COLLINEAR ring is structurally valid but covers zero area; it
  // must not slip past sanitation and leave isEmpty/bounds disagreeing with a
  // later boolean (the adversarial edge case behind the constructor sanitation).
  const collinear = new Contours2D(
    Float64Array.from([0, 0, 1, 0, 2, 0]),
    Uint32Array.from([3]),
  );
  try {
    assert.equal(collinear.ringCount, 0, 'a zero-area ring must be dropped');
    assert.equal(collinear.isEmpty, true);
    assert.equal(collinear.bounds(), undefined, 'bounds() must not span a dropped ring');
  } finally {
    collinear.free();
  }
});

test('coords/ringLengths round-trip the constructor across the boundary', () => {
  const ring = rectCcw(0, 0, 2, 3);
  const set = contours(ring);
  try {
    assert.deepEqual(Array.from(set.coords()), ring);
    assert.deepEqual(Array.from(set.ringLengths()), [4]);
    assert.equal(set.ringCount, 1);
    assert.equal(set.isEmpty, false);
    // A raw ring soup carries no shape grouping until an op resolves it.
    assert.equal(set.shapeCount, 0);
  } finally {
    set.free();
  }
});

test('difference2d keeps every disjoint island', () => {
  // The guarantee `subtract_2d` cannot give: a bar cut in two by a strip must
  // come back as TWO shapes, not just the larger remnant.
  const bar = contours(rectCcw(0, 0, 10, 1));
  const cutter = contours(rectCcw(4, -1, 6, 2));
  const out = difference2d(bar, cutter);
  try {
    assert.equal(out.shapeCount, 2, 'both remnants must survive');
    assert.deepEqual(Array.from(out.shapeOffsets()), [0, 1]);
    assert.ok(Math.abs(coveredArea(out) - 8) < 1e-9, `area ${coveredArea(out)}`);
  } finally {
    out.free();
    cutter.free();
    bar.free();
  }
});

test('difference2d punches a hole and reports the holed shape as one region', () => {
  const outer = contours(rectCcw(0, 0, 10, 10));
  const inner = contours(rectCcw(4, 4, 6, 6));
  const holed = difference2d(outer, inner);
  try {
    assert.equal(holed.shapeCount, 1);
    assert.equal(holed.ringCount, 2, 'outer boundary + hole');
    assert.deepEqual(Array.from(holed.shapeOffsets()), [0]);
    // Hole ring is CW, so it subtracts: 100 - 4.
    assert.ok(Math.abs(coveredArea(holed) - 96) < 1e-9, `area ${coveredArea(holed)}`);
    const bounds = holed.bounds();
    assert.deepEqual(Array.from(bounds), [0, 0, 10, 10]);
    // ring() must agree with the bulk coords() readout.
    assert.deepEqual(Array.from(holed.ring(0)), Array.from(holed.coords()).slice(0, 8));
    assert.equal(holed.ring(2), undefined, 'out-of-range ring index');
  } finally {
    holed.free();
    inner.free();
    outer.free();
  }
});

test('intersection2d clips to the shared region', () => {
  const a = contours(rectCcw(0, 0, 2, 2));
  const b = contours(rectCcw(1, 1, 3, 3));
  const out = intersection2d(a, b);
  try {
    assert.equal(out.shapeCount, 1);
    assert.ok(Math.abs(coveredArea(out) - 1) < 1e-9);
  } finally {
    out.free();
    b.free();
    a.free();
  }
});

test('an empty operand has a defined answer, not a crash', () => {
  const a = contours(rectCcw(0, 0, 1, 1));
  const empty = new Contours2D(new Float64Array(), new Uint32Array());
  const u = union2d(empty, a);
  const d = difference2d(empty, a);
  const i = intersection2d(a, empty);
  try {
    assert.equal(empty.isEmpty, true);
    assert.equal(empty.bounds(), undefined);
    assert.ok(Math.abs(coveredArea(u) - 1) < 1e-9, 'union with empty is identity');
    assert.equal(d.isEmpty, true, 'nothing minus something is nothing');
    assert.equal(i.isEmpty, true, 'intersection with empty is empty');
  } finally {
    i.free();
    d.free();
    u.free();
    empty.free();
    a.free();
  }
});

test('Contours2D.fromMeshOutline feeds a real meshOutline2d result into a boolean', () => {
  // Two triangles forming the unit square in z=0, viewed down Z (axis 2).
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const outline = meshOutline2d(positions, indices, 2, false);
  assert.ok(outline, 'meshOutline2d must produce a footprint');

  const adopted = Contours2D.fromMeshOutline(outline);
  const resolved = resolve2d(adopted);
  const cutter = contours(rectCcw(0.25, -1, 0.75, 2));
  const cut = difference2d(adopted, cutter);
  try {
    assert.equal(adopted.ringCount, outline.contourCount, 'every ring must be adopted');
    assert.ok(Math.abs(coveredArea(resolved) - 1) < 1e-6, 'outline area survives adoption');
    assert.equal(cut.shapeCount, 2, 'the strip splits the footprint in two');
    assert.ok(Math.abs(coveredArea(cut) - 0.5) < 1e-6, `area ${coveredArea(cut)}`);
  } finally {
    cut.free();
    cutter.free();
    resolved.free();
    adopted.free();
    outline.free();
  }
});

test('operations return new handles and leave their operands usable', () => {
  // The accumulating occluder loop depends on this: freeing the result must
  // not invalidate the operands, and the operands must be unmodified.
  const a = contours(rectCcw(0, 0, 2, 2));
  const b = contours(rectCcw(1, 1, 3, 3));
  const first = union2d(a, b);
  first.free();
  const second = union2d(a, b);
  try {
    assert.ok(Math.abs(coveredArea(second) - 7) < 1e-9, 'operands survive an op + free');
    assert.ok(Math.abs(coveredArea(a) - 4) < 1e-9, 'union2d must not mutate its subject');
  } finally {
    second.free();
    b.free();
    a.free();
  }
});

// ===== splitMeshByZones across the real WASM boundary (#2508) =====

/** A 6 x 1 x 1 m box from the origin, as flat f64 positions + indices. */
function boxMesh(x0, y0, z0, x1, y1, z1) {
  const positions = Float64Array.from([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = Uint32Array.from([
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7,
    0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  ]);
  return { positions, indices };
}

test('splitMeshByZones cuts a wall at a known fraction and the pieces add up', () => {
  // The wall spans x = 0..6, so a boundary at x = 2 leaves exactly 2 m3 below
  // it. Crossing the real boundary matters here beyond the Rust unit test:
  // the zones arrive as a FLAT Float64Array whose stride and field order this
  // side has to agree on, and a transposed size/centre would still produce a
  // plausible-looking split.
  const { positions, indices } = boxMesh(0, 0, 0, 6, 1, 1);
  const zones = Float64Array.from([
    0.5, 0.5, 0.5, 3, 4, 4, 0,   // covers x = -1..2
    4.5, 0.5, 0.5, 5, 4, 4, 0,   // covers x = 2..7
  ]);
  const split = splitMeshByZones(positions, indices, zones);
  try {
    assert.ok(Math.abs(split.wholeVolume - 6) < 1e-9, `whole volume ${split.wholeVolume}`);
    assert.ok(split.sumErrorRel < 1e-9, `pieces do not sum to the whole: ${split.sumErrorRel}`);
    const byZone = new Map();
    for (let i = 0; i < split.pieceCount; i++) {
      const piece = split.piece(i);
      try {
        byZone.set(piece.zoneIndex, piece.volume);
        assert.ok(piece.positions.length > 0 && piece.indices.length > 0, 'piece has geometry');
      } finally {
        piece.free();
      }
    }
    assert.ok(Math.abs(byZone.get(0) - 2) < 1e-9, `zone 0 got ${byZone.get(0)}`);
    assert.ok(Math.abs(byZone.get(1) - 4) < 1e-9, `zone 1 got ${byZone.get(1)}`);
  } finally {
    split.free();
  }
});

test('splitMeshByZones keeps an element no zone reaches, as the remainder', () => {
  const { positions, indices } = boxMesh(0, 0, 0, 6, 1, 1);
  const zones = Float64Array.from([100, 0, 0, 2, 2, 2, 0]);
  const split = splitMeshByZones(positions, indices, zones);
  try {
    assert.equal(split.pieceCount, 1);
    const piece = split.piece(0);
    try {
      // -1, not 0: an element in no zone must not be reported as being in the
      // first one.
      assert.equal(piece.zoneIndex, -1);
      assert.ok(Math.abs(piece.volume - 6) < 1e-9);
    } finally {
      piece.free();
    }
  } finally {
    split.free();
  }
});

test('splitMeshByZones cuts by a prism footprint, not by its bounding box', () => {
  // The triangle (0,0) - (6,0) - (0,1) halves the wall's 6 x 1 m plan along the
  // diagonal, so it takes exactly half the volume. Its BOUNDING BOX is the
  // whole wall, so a binding that dropped the footprint would answer 6.
  const { positions, indices } = boxMesh(0, 0, 0, 6, 1, 1);
  const zones = Float64Array.from([3, 0.5, 0.5, 6, 4, 1, 0]);
  const split = splitMeshByZones(
    positions,
    indices,
    zones,
    Float64Array.from([0, 0, 6, 0, 0, 1]),
    Uint32Array.from([3]),
  );
  try {
    const piece = split.piece(0);
    try {
      assert.equal(piece.zoneIndex, 0);
      assert.ok(Math.abs(piece.volume - 3) < 1e-6, `prism piece is ${piece.volume} m3, expected 3`);
    } finally {
      piece.free();
    }
    assert.ok(split.sumErrorRel < 1e-9, `sum error ${split.sumErrorRel}`);
  } finally {
    split.free();
  }
});

// ===== Prepass class column across the real WASM boundary (#2088) =====
// Self-contained suite in its own module (this file is already several times
// the size guideline); it owns its fixture and its own IfcAPI handles.
await runPrepassClassBoundaryTests(api, test);

// ===== The #3395 refusal count across the real WASM boundary =====
// A refused record is absent from the entity-index columns, so these two
// wasm outputs are the only evidence of it that reaches the host — and the
// host reads both through a `??` fallback, which turns a boundary regression
// into "this file refused nothing". Same module split, same reason.
await runShardRefusalBoundaryTests(api, test);


// Summary
console.log('\n' + '═'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('═'.repeat(50));

if (failed > 0) {
  process.exit(1);
}
