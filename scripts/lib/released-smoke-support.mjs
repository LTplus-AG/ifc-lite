/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Probes (run in cleaned-env child processes), argument and toolchain helpers for smoke-released-retained.mjs (#7955). */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROBE_FLAG = '--wasm-probe';
export const RETAINED_PROBE_FLAG = '--retained-probe';

export function* walkFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) yield* walkFiles(path);
    else if (stat.isFile()) yield path;
  }
}

export function parseArgs(argv) {
  const out = { wheel: 'latest' };
  const known = new Set(['wasm', 'cli', 'crate', 'wheel', 'out', 'fixture', 'retained-engine', 'toolchain']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--strict') out.strict = true;
    else if (a.startsWith('--') && known.has(a.slice(2))) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} requires a value`);
      out[a.slice(2)] = value;
    } else throw new Error(`Unknown argument ${a}`);
  }
  for (const k of ['wasm', 'cli', 'crate']) if (!out[k]) throw new Error(`--${k} VERSION is required (explicit version)`);
  return out;
}

/** --toolchain > RUSTUP_TOOLCHAIN > the channel pinned in the repo's rust-toolchain.toml. */
export function chooseToolchain(options, repo, environment = process.env) {
  if (options.toolchain) return { name: options.toolchain, source: '--toolchain' };
  if (environment.RUSTUP_TOOLCHAIN) return { name: environment.RUSTUP_TOOLCHAIN, source: 'RUSTUP_TOOLCHAIN' };
  try {
    const channel = readFileSync(join(repo, 'rust-toolchain.toml'), 'utf8').match(/^\s*channel\s*=\s*"([^"]+)"/m)?.[1];
    if (channel) return { name: channel, source: 'rust-toolchain.toml' };
  } catch { /* fall through */ }
  return { name: undefined, source: 'rustup default' };
}

/** Child: load the published default engine and process the fixture. */
export async function wasmProbe(packageDir, fixture) {
  const url = (rel) => pathToFileURL(join(packageDir, rel)).href;
  const engine = await import(url('pkg/ifc-lite.js'));
  engine.initSync({ module: readFileSync(join(packageDir, 'pkg/ifc-lite_bg.wasm')) });
  const api = new engine.IfcAPI();
  const data = readFileSync(fixture);
  const pre = api.buildPrePassOnce(data);
  const [x = 0, y = 0, z = 0] = pre.rtcOffset ?? [];
  const meshes = api.processGeometryBatch(data, pre.jobs, pre.unitScale, x, y, z, pre.needsShift, pre.voidKeys,
    pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors, pre.planeAngleToRadians, pre.materialElementIds,
    pre.materialColorCounts, pre.materialColors);
  console.log(JSON.stringify({ version: api.version, ready: api.is_ready, jobs: pre.totalJobs, meshes: meshes.length,
    triangles: meshes.totalTriangles, vertices: meshes.totalVertices }));
}

/** Child: import the registry's retained.js and record exactly how loadRetainedEngine() fails with no engine installed. */
export async function retainedProbe(project) {
  const entry = createRequire(join(project, 'package.json')).resolve('@ifc-lite/wasm/retained');
  const module = await import(pathToFileURL(entry).href);
  const result = { entry, hasLoader: typeof module.loadRetainedEngine === 'function' };
  if (result.hasLoader) {
    try { await module.loadRetainedEngine(); result.rejected = false; } catch (error) {
      result.rejected = true; result.code = error?.code; result.name = error?.name; result.message = String(error?.message).slice(0, 300);
    }
  }
  console.log(JSON.stringify(result));
}
