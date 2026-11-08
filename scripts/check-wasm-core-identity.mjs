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

// FNV-1a 64 over every getter a `MeshDataJs` exposes (positions, normals,
// indices, uvs, colour, ids, origin, ...), read off the wasm-bindgen class
// prototype so a field added later is compared without editing this list.
function digestInto(state, value) {
  const eat = (bytes) => { for (const b of bytes) state.h = ((state.h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn; };
  if (ArrayBuffer.isView(value)) eat(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  else eat(new TextEncoder().encode(JSON.stringify(value === undefined ? null : value, (_, v) => (typeof v === 'bigint' ? String(v) : v))));
}

function meshGetters(mesh) {
  const names = [];
  for (let proto = Object.getPrototypeOf(mesh); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) if (d.get) names.push(name);
  }
  return names.sort();
}

// The canonical path (`buildPrePassOnce` + one `processGeometryBatch`), as
// scripts/lib/mesh-via-prepass.mjs runs it, but digesting the wasm meshes
// themselves rather than that facade's copied subset.
function mesh(api, content) {
  const bytes = new TextEncoder().encode(content);
  try {
    const pre = api.buildPrePassOnce(bytes);
    const state = { h: 0xcbf29ce484222325n };
    let meshes = 0, triangles = 0, fields = 0;
    if (pre && pre.jobs && pre.totalJobs > 0) {
      const [x, y, z] = pre.rtcOffset ? [pre.rtcOffset[0] || 0, pre.rtcOffset[1] || 0, pre.rtcOffset[2] || 0] : [0, 0, 0];
      const col = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        for (let i = 0; i < col.length; i++) {
          const m = col.get(i);
          if (!m) continue;
          try {
            const names = meshGetters(m);
            fields = Math.max(fields, names.length);
            for (const name of names) { digestInto(state, name); digestInto(state, m[name]); }
            meshes++; triangles += m.triangleCount;
          } finally { m.free(); }
        }
      } finally { col.free(); }
    }
    return { meshes, triangles, fields, digest: state.h.toString(16).padStart(16, '0') };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    api.clearPrePassCache?.();
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
let same = 0, differ = 0, meshed = 0, failedBoth = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const fullApi = new full.glue.IfcAPI(), coreApi = new core.glue.IfcAPI();
  const a = mesh(fullApi, content), b = mesh(coreApi, content);
  fullApi.free(); coreApi.free();
  // A fixture that fails on both engines is not identity evidence, whatever
  // the messages say: count it apart, never as identical.
  const ok = !(a.error && b.error) && JSON.stringify(a) === JSON.stringify(b);
  if (a.error && b.error) { /* counted in failedBoth below */ } else if (ok) same++; else differ++;
  if (!a.error && a.meshes > 0) meshed++;
  if (a.error && b.error) failedBoth++;
  if (!ok && !(a.error && b.error)) console.log(`DIFF ${relative(ROOT, file)} full=${JSON.stringify(a)} core=${JSON.stringify(b)}`);
}
console.log(`identity: ${same} identical, ${differ} different, ${meshed} with meshes, ${failedBoth} failing on both, of ${files.length} fixtures`);
// Identical errors compare equal, so a run in which nothing meshed proves
// nothing: require meshes, and that most fixtures produced them.
const vacuous = meshed === 0 || meshed < files.length / 2;
if (vacuous) console.error(`only ${meshed} of ${files.length} fixtures produced meshes: no identity evidence`);
process.exit(differ === 0 && !vacuous ? 0 : 1);
