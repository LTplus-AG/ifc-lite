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
  const known = new Set(['wasm', 'cli', 'crate', 'wheel', 'out', 'fixture', 'retained-engine', 'toolchain', 'expect-engine-manifest-sha256', 'expect-sdk-revision']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--') && known.has(a.slice(2))) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} requires a value`);
      out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    } else throw new Error(`Unknown argument ${a}`);
  }
  for (const k of ['wasm', 'cli', 'crate']) if (!out[k]) throw new Error(`--${k} VERSION is required (explicit version)`);
  if (!/^(latest|skip|\d+(\.\d+)+((a|b|rc)\d+)?(\.post\d+)?)$/.test(out.wheel)) throw new Error(`--wheel must be latest, skip or a version such as 4.15.0 (got '${out.wheel}')`);
  if (out.strict && out.wheel === 'latest') throw new Error('--strict requires an explicit --wheel X.Y.Z (a moving "latest" is not release evidence)');
  if (out.expectEngineManifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(out.expectEngineManifestSha256)) throw new Error('--expect-engine-manifest-sha256 must be 64 hex characters');
  if (out.expectSdkRevision !== undefined && !/^[a-f0-9]{40}$/.test(out.expectSdkRevision)) throw new Error('--expect-sdk-revision must be 40 hex characters');
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

/** Isolated, site-less interpreter: no system or user site-packages can stand in for the wheel. */
export const WHEEL_PYTHON_FLAGS = ['-I', '-S'];

/** argv for the wheel import probe: the module must be loaded from inside the extracted wheel directory. */
export function wheelProbeArgv(fixture, target) {
  const code = [
    'import os, sys, json',
    'sys.path.insert(0, sys.argv[2])',
    'import ifclite_geom',
    'root = os.path.realpath(sys.argv[2]) + os.sep',
    'assert os.path.realpath(ifclite_geom.__file__).startswith(root), "ifclite_geom was not loaded from the wheel: " + ifclite_geom.__file__',
    'd = json.loads(ifclite_geom.geometry_data_json(open(sys.argv[1], "rb").read()))',
    'print(d["element_count"])',
  ].join('\n');
  return [...WHEEL_PYTHON_FLAGS, '-c', code, fixture, target];
}

/** The staged engine directory: --retained-engine, else IFCLITE_SMOKE_RETAINED_ENGINE. */
export function retainedEngineFrom(options, environment = process.env) {
  return options.retainedEngine ?? environment.IFCLITE_SMOKE_RETAINED_ENGINE;
}

/** The option values the smoke acts on, after normalisation; `--dry-run` prints exactly this. */
export function effectiveSettings(options, environment = process.env) {
  return {
    retainedEngine: retainedEngineFrom(options, environment), strict: Boolean(options.strict), wheel: options.wheel,
    expectEngineManifestSha256: options.expectEngineManifestSha256, expectSdkRevision: options.expectSdkRevision,
  };
}
