#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Snap edge reconstruction against the REAL wasm pipeline (issue #2199).
 *
 * The unit suite in `packages/renderer/src/snap-geometry-cache.test.ts` builds
 * its own unwelded meshes, which pins the algorithm but not the geometry the
 * mesher actually emits. This gate drives the shipped path end to end — wasm
 * `processGeometryBatch` -> MeshData -> `buildGeometryCache` -> `SnapDetector`
 * — over the committed samples, and asserts the INVARIANTS (one edge per
 * straight run; the reported length is the whole run; the answer does not move
 * when triangle emission order does) rather than a magic number, so a
 * legitimate tessellation change does not turn it into a brittle snapshot.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initSync, IfcAPI } from '../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM_BIN = join(ROOT_DIR, 'packages/wasm/pkg/ifc-lite_bg.wasm');
const RENDERER_DIST = join(ROOT_DIR, 'packages/renderer/dist/snap-geometry-cache.js');
const DETECTOR_DIST = join(ROOT_DIR, 'packages/renderer/dist/snap-detector.js');
const SAMPLES = join(ROOT_DIR, 'apps/viewer/public/samples');

console.log('Snap edge reconstruction (real wasm pipeline)\n');

// Per AGENTS.md: skip cleanly when the build outputs are absent, naming the fix.
// CI restores them before this step, so a skip here means a LOCAL run without a
// build, never a verified one. Every message says so explicitly: a reader who
// greps for "Skipping" must not be able to mistake it for a passing gate.
function skipUnbuilt(what, fix) {
  console.log(`VERIFIED NOTHING: ${what} missing - run \`${fix}\`. Skipping.`);
  process.exit(0);
}

if (!existsSync(WASM_BIN)) skipUnbuilt('wasm runtime', 'bash scripts/build-wasm.sh');
if (!existsSync(RENDERER_DIST)) skipUnbuilt('renderer dist (snap-geometry-cache)', 'pnpm build');
// Checked alongside the others rather than left to the dynamic import: an
// unchecked import fails with a module-resolution stack rather than the
// actionable build message the other two give.
if (!existsSync(DETECTOR_DIST)) skipUnbuilt('renderer dist (snap-detector)', 'pnpm build');

const { buildGeometryCache } = await import(RENDERER_DIST);
const { SnapDetector } = await import(DETECTOR_DIST);

initSync(readFileSync(WASM_BIN));
const api = new IfcAPI();

function loadMeshes(name) {
  const collection = parseMeshesViaPrePass(api, readFileSync(join(SAMPLES, name), 'utf-8'));
  const meshes = [];
  for (let i = 0; i < collection.length; i++) meshes.push(collection.get(i));
  return meshes;
}

/** Perpendicular distance from `p` to the line through `o` with unit direction `d`. */
function perp(p, o, d) {
  const rx = p.x - o.x, ry = p.y - o.y, rz = p.z - o.z;
  const a = rx * d.x + ry * d.y + rz * d.z;
  return Math.hypot(rx - a * d.x, ry - a * d.y, rz - a * d.z);
}

/**
 * Cache edges that still share a supporting line with another cache edge AND
 * abut or overlap it: every one of those is a model edge the cache is still
 * serving in fragments. Must be zero PER MESHDATA PIECE - that is the scope the
 * cache merges at, and the scope this gate asserts. At MODEL scope the samples
 * still carry cross-piece splits (mesh fragmentation routinely emits one
 * element as many pieces, e.g. infra-bridge #156 as 14, with one 9.909 m edge
 * split across pieces), a known residual this gate deliberately does not gate.
 */
function residualSplits(edges) {
  const EPS = 1e-5;
  const groups = [];
  for (const e of edges) {
    const dx = e.v1.x - e.v0.x, dy = e.v1.y - e.v0.y, dz = e.v1.z - e.v0.z;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) continue;
    const d = { x: dx / len, y: dy / len, z: dz / len };
    let group = groups.find((g) => perp(e.v0, g.o, g.d) <= EPS && perp(e.v1, g.o, g.d) <= EPS);
    if (!group) {
      group = { o: e.v0, d, spans: [] };
      groups.push(group);
    }
    const t = (p) => (p.x - group.o.x) * group.d.x + (p.y - group.o.y) * group.d.y + (p.z - group.o.z) * group.d.z;
    const a = t(e.v0), b = t(e.v1);
    group.spans.push(a <= b ? [a, b] : [b, a]);
  }
  let splits = 0;
  for (const group of groups) {
    group.spans.sort((x, y) => x[0] - y[0]);
    // Compare against the running MAXIMUM end, not just the previous span's.
    // Sorting by start does not order by end, so a long span that ENCLOSES the
    // next one leaves `spans[i - 1][1]` smaller than the true reach: the
    // enclosed span is caught, then the one after it is compared against the
    // short enclosed end and read as disjoint. That under-reports splits, i.e.
    // it weakens the very assertion this function exists to make.
    let maxEnd = group.spans[0][1];
    for (let i = 1; i < group.spans.length; i++) {
      if (group.spans[i][0] <= maxEnd + EPS) splits++;
      if (group.spans[i][1] > maxEnd) maxEnd = group.spans[i][1];
    }
  }
  return splits;
}

/**
 * A stable, order-independent signature of a whole cache - the welded VERTEX
 * list, endpoints, length, AND the valence/junction channel. v0/v1/length
 * alone cannot see valences, and an emission-order dependence hid in exactly
 * that blind spot once: valences feed `isCorner` and the corner confidence, so
 * they are as user-visible as the endpoints. The vertices are included because
 * the WELD itself once moved with input order (a first-hit representative
 * scheme on a tolerance chain), which shifts representative points and
 * adjacency before any edge is even classified.
 */
function signature(cache) {
  return [
    ...cache.vertices.map((v) => `p:${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`).sort(),
    ...cache.edges
      .map((e) => [
        ...[e.v0.x, e.v0.y, e.v0.z, e.v1.x, e.v1.y, e.v1.z, e.length].map((n) => n.toFixed(6)),
        `val:${e.v0Valence}/${e.v1Valence}`,
        `j:[${e.junctions
          .map((j) => `${j.point.x.toFixed(6)},${j.point.y.toFixed(6)},${j.point.z.toFixed(6)},v${j.valence},t${j.t.toFixed(6)}`)
          .join(';')}]`,
      ].join(','))
      .sort(),
  ].join('|');
}

let checks = 0;

for (const sample of ['hello-wall.ifc', 'building-architecture.ifc', 'infra-bridge.ifc']) {
  if (!existsSync(join(SAMPLES, sample))) {
    console.log(`  ${sample} missing. Skipping.`);
    continue;
  }
  const meshes = loadMeshes(sample);
  let edges = 0, splits = 0;
  for (const mesh of meshes) {
    const cache = buildGeometryCache(mesh);
    edges += cache.edges.length;
    splits += residualSplits(cache.edges);
  }
  // A present-but-empty sample would sail through: `splits` stays 0, the
  // assertion passes, and the check is counted. Same vacuous shape as a run
  // with no samples at all, one level in - so require the sample to have
  // actually produced geometry before its zero means anything.
  assert.ok(meshes.length > 0, `${sample}: loaded 0 meshes, so its 0 split runs prove nothing`);
  assert.ok(edges > 0, `${sample}: produced 0 reconstructed edges, so its 0 split runs prove nothing`);
  assert.equal(splits, 0, `${sample}: ${splits} model edges are still served in fragments within a single piece`);
  console.log(`  ok ${sample}: ${meshes.length} meshes, ${edges} reconstructed edges, 0 split runs within any single MeshData piece`);
  checks++;
}

// The measured case: IfcSlab #52 of building-architecture.ifc carries a straight
// 2.000 m opening edge at x = 5.600, y = 0.000, z = -5.000 .. -3.000. It used to
// arrive as 0.200 / 1.800 / 1.600 / 0.200 and no cursor on it ever read 2.000.
if (existsSync(join(SAMPLES, 'building-architecture.ifc'))) {
  const meshes = loadMeshes('building-architecture.ifc');
  const meshIndex = meshes.findIndex((m) => m.expressId === 52);
  assert.ok(meshIndex >= 0, 'IfcSlab #52 has no mesh');
  const cache = buildGeometryCache(meshes[meshIndex]);
  const onLine = (v) => Math.abs(v.x - 5.6) < 1e-3 && Math.abs(v.y) < 1e-3;
  const run = cache.edges.filter((e) => onLine(e.v0) && onLine(e.v1));
  assert.equal(run.length, 1, `slab #52 opening edge is ${run.length} cache edges, expected 1`);
  assert.ok(Math.abs(run[0].length - 2) < 1e-3, `slab #52 opening edge reads ${run[0].length.toFixed(4)} m`);
  console.log(`  ok slab #52 opening edge: one run of ${run[0].length.toFixed(4)} m`);
  checks++;

  const camera = { position: { x: 5.62, y: 5, z: -4 }, fov: Math.PI / 4 };
  const ray = { origin: camera.position, direction: { x: 0, y: -1, z: 0 } };
  const detector = new SnapDetector();
  for (const z of [-4.5, -4.0, -3.5]) {
    const point = { x: 5.62, y: 0, z };
    const result = detector.detectMagneticSnap(
      ray, meshes,
      { point, normal: { x: 0, y: 1, z: 0 }, distance: 5, meshIndex, triangleIndex: 0, expressId: 52 },
      camera, 800, { edge: null, meshExpressId: null, lockStrength: 0 }
    );
    const [a, b] = result.snapTarget?.metadata?.vertices ?? [];
    const reported = a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : NaN;
    assert.ok(Math.abs(reported - 2) < 1e-3, `cursor z=${z} reported ${reported.toFixed(4)} m, not 2.0000`);
  }
  console.log('  ok slab #52: every cursor along the edge reports the full 2.0000 m');
  checks++;

  // Anti-#2388: reversing triangle emission order must not move a single edge.
  const mesh = meshes[meshIndex];
  const reversed = {
    ...mesh,
    indices: (() => {
      const out = new Uint32Array(mesh.indices.length);
      const tris = mesh.indices.length / 3;
      for (let t = 0; t < tris; t++) {
        const src = (tris - 1 - t) * 3;
        out[t * 3] = mesh.indices[src];
        out[t * 3 + 1] = mesh.indices[src + 1];
        out[t * 3 + 2] = mesh.indices[src + 2];
      }
      return out;
    })(),
  };
  assert.equal(
    signature(buildGeometryCache(reversed)),
    signature(cache),
    'the cache moved when triangle emission order did'
  );
  console.log('  ok slab #52: the cache is invariant under triangle emission order');
  checks++;
}

// The shallow-crease band: infra-bridge #723 carries a 3.500 m deck edge whose
// adjacent faces meet at 3.617 degrees (dot 0.998). A 0.98 coplanar cutoff
// deleted it and the whole sub-11.5-degree band (1093 real creases on this
// file, 44 of them 0.5 m or longer) - geometry where real BIM slopes live
// (a 2% drainage fall is 1.15 degrees). It must be a cache edge.
if (existsSync(join(SAMPLES, 'infra-bridge.ifc'))) {
  const meshes = loadMeshes('infra-bridge.ifc');
  const P = { x: 7.785, y: 7.375, z: -53.484 };
  const Q = { x: 9.535, y: 7.375, z: -56.516 };
  const near = (a, b) => Math.abs(a.x - b.x) < 2e-3 && Math.abs(a.y - b.y) < 2e-3 && Math.abs(a.z - b.z) < 2e-3;
  let found = null;
  for (const mesh of meshes) {
    if (mesh.expressId !== 723) continue;
    for (const e of buildGeometryCache(mesh).edges) {
      if ((near(e.v0, P) && near(e.v1, Q)) || (near(e.v0, Q) && near(e.v1, P))) found = e;
    }
  }
  assert.ok(found, 'the 3.617 degree deck crease of #723 is missing from the snap cache');
  console.log(`  ok infra-bridge #723: the 3.617 degree deck crease is a ${found.length.toFixed(3)} m snap edge`);
  checks++;
}

// A gate that skips every sample and still exits 0 verifies nothing while
// reporting success - the exact vacuous-pass shape this suite exists to catch
// elsewhere. Individual samples may legitimately be absent (a shallow checkout,
// a fixtures-less environment), so a missing file is a skip, but a run where
// NOTHING was checked is a failure, not a pass.
assert.ok(
  checks > 0,
  'test-snap-edges verified NOTHING: every sample was missing, so the gate would ' +
    'have reported success without exercising a single edge. Fetch the sample ' +
    `IFCs into ${SAMPLES} before trusting this gate.`,
);

console.log(`\n${checks} checks passed.`);
