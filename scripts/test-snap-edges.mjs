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
const SAMPLES = join(ROOT_DIR, 'apps/viewer/public/samples');

console.log('Snap edge reconstruction (real wasm pipeline)\n');

// Per AGENTS.md: skip cleanly when the build outputs are absent, naming the fix.
if (!existsSync(WASM_BIN)) {
  console.log('wasm runtime missing - run `bash scripts/build-wasm.sh`. Skipping.');
  process.exit(0);
}
if (!existsSync(RENDERER_DIST)) {
  console.log('renderer dist missing - run `pnpm build`. Skipping.');
  process.exit(0);
}

const { buildGeometryCache } = await import(RENDERER_DIST);
const { SnapDetector } = await import(join(ROOT_DIR, 'packages/renderer/dist/snap-detector.js'));

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
 * serving in fragments. Must be zero.
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
    for (let i = 1; i < group.spans.length; i++) {
      if (group.spans[i][0] <= group.spans[i - 1][1] + EPS) splits++;
    }
  }
  return splits;
}

/** A stable, order-independent signature of a whole cache. */
function signature(edges) {
  return edges
    .map((e) => [e.v0.x, e.v0.y, e.v0.z, e.v1.x, e.v1.y, e.v1.z, e.length].map((n) => n.toFixed(6)).join(','))
    .sort()
    .join('|');
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
  assert.equal(splits, 0, `${sample}: ${splits} model edges are still served in fragments`);
  console.log(`  ok ${sample}: ${meshes.length} meshes, ${edges} reconstructed edges, 0 split runs`);
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
    signature(buildGeometryCache(reversed).edges),
    signature(cache.edges),
    'the cache moved when triangle emission order did'
  );
  console.log('  ok slab #52: the cache is invariant under triangle emission order');
  checks++;
}

console.log(`\n${checks} checks passed.`);
