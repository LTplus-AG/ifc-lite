#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mesh byte-identity between the full engine (`packages/wasm/pkg`) and the
 * geometry-core engine (`packages/wasm/pkg-core`, `BUILD_CORE=1
 * scripts/build-wasm.sh`). The core bundle drops whole `IfcAPI` method
 * families (exporters, LandXML, clash, scan, PDF), never a step of the mesh
 * pipeline, so every fixture must mesh to the same bytes through both.
 *
 * Usage: node scripts/check-wasm-core-identity.mjs [--max-mb N] [fixture.ifc ...]
 * Without fixture arguments it walks tests/models (`pnpm fixtures`).
 * Exit 1 on any digest, count or error mismatch; prints a summary and sizes.
 *
 * @unwired-by-design ordinary CI lanes do not build the core bundle (a second
 * LTO link, `BUILD_CORE=1`), and the release that does has no fixtures. Run it
 * when a change could split the two engines' mesh code; PR #9377 records the run.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { parseMeshesViaPrePass } from './lib/mesh-via-prepass.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const maxMbAt = args.indexOf('--max-mb');
const maxBytes = (maxMbAt >= 0 ? Number(args.splice(maxMbAt, 2)[1]) : 80) * 1024 * 1024;

async function loadEngine(dir) {
  const glue = await import(pathToFileURL(join(ROOT, 'packages/wasm', dir, 'ifc-lite.js')).href);
  const binary = readFileSync(join(ROOT, 'packages/wasm', dir, 'ifc-lite_bg.wasm'));
  glue.initSync({ module: binary });
  return { glue, binary };
}

// FNV-1a 64 over every field the geometry package copies out of a mesh.
function digest(meshes) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
  const eat = (bytes) => { for (const b of bytes) h = ((h ^ BigInt(b)) * prime) & mask; };
  const enc = new TextEncoder();
  for (const m of meshes) {
    eat(enc.encode(JSON.stringify([m.expressId, m.ifcType, m.geometryClass, m.geometryItemId,
      m.materialId, Array.from(m.color ?? []), m.origin ?? null, m.vertexCount, m.triangleCount])));
    for (const a of [m.positions, m.normals, m.indices]) eat(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  return h.toString(16).padStart(16, '0');
}

function mesh(api, content) {
  try {
    const col = parseMeshesViaPrePass(api, content);
    const meshes = [];
    for (let i = 0; i < col.length; i++) meshes.push(col.get(i));
    return { meshes: meshes.length, triangles: col.totalTriangles, digest: digest(meshes) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function fixtures(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...fixtures(p));
    else if (/\.ifc$/i.test(name) && st.size <= maxBytes) out.push(p);
  }
  return out.sort();
}

const full = await loadEngine('pkg');
if (!existsSync(join(ROOT, 'packages/wasm/pkg-core/ifc-lite_bg.wasm'))) {
  console.error('packages/wasm/pkg-core is missing: run BUILD_CORE=1 scripts/build-wasm.sh');
  process.exit(1);
}
const core = await loadEngine('pkg-core');
if (core.glue.ENGINE_BINARY_URL === null || full.glue.ENGINE_BINARY_URL !== null) {
  console.error('engine-binary markers wrong: full must export null, core its own URL');
  process.exit(1);
}

for (const [label, { binary }] of [['full', full], ['core', core]]) {
  const gz = gzipSync(binary, { level: 9 }).length;
  const br = brotliCompressSync(binary, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  console.log(`size ${label}: raw ${binary.length} gzip-9 ${gz} brotli-11 ${br}`);
}

const files = args.length ? args : fixtures(join(ROOT, 'tests/models'));
let same = 0, differ = 0, meshed = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const fullApi = new full.glue.IfcAPI(), coreApi = new core.glue.IfcAPI();
  const a = mesh(fullApi, content), b = mesh(coreApi, content);
  fullApi.free(); coreApi.free();
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) same++; else differ++;
  if (!a.error && a.meshes > 0) meshed++;
  if (!ok) console.log(`DIFF ${relative(ROOT, file)} full=${JSON.stringify(a)} core=${JSON.stringify(b)}`);
}
console.log(`identity: ${same} identical, ${differ} different, ${meshed} with meshes, of ${files.length} fixtures`);
process.exit(differ === 0 && files.length > 0 ? 0 : 1);
