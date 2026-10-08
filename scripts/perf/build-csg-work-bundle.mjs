#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.
// Build a self-contained #6516 diagnostic bundle from two historical source commits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is copied on its own into the work bundle (see `copyProjectTools` in
// build-csg-work-bundle.mjs), where scripts/lib does not exist, so the entry-point
// check is spelled here instead of imported. Same rule as scripts/lib/is-main-entry.mjs:
// `argv[1]` is resolved through realpath, because `import.meta.url` already is.
function isMainEntry(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

const exec = promisify(execFile);
const runTimeoutMs = 10 * 60 * 1000;
const maxLogBytes = 8 * 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const sourceSpecs = [
  {
    name: 'release6', commit: 'e69750fb08e2cc5bbb62e63737d658a852f8a03f',
    patch: 'scripts/perf/csg-work-release6.patch', patchSha256: '0706573c1add572b358b5f3307a334c346db21c082aea39227c6238d63b86d9b',
    geometry: '6.0.0', wasm: '8.0.1', data: '4.2.1', meshSha256: '981d74ad4aa4ee39ef08e56f1ed321fe06572270269050d586edddb5debfde16',
  },
  {
    name: 'release7', commit: 'd6e56c8cad8a673d97ab369e4373ce015d3f9c56',
    patch: 'scripts/perf/csg-work-release7.patch', patchSha256: 'df34489411dd98f5c22a8d6c9351b209c72cf3dfe6820dc41cd30938293f3662',
    geometry: '7.0.0', wasm: '9.0.0', data: '4.4.0', meshSha256: '37bdaf83404efaa9ec90f2c8f9e60e882ac18b290ed33bc1b1609aa9cd994e38',
  },
];
const requiredNames = ['ifc-lite_bg.wasm', 'ifc-lite.js', 'ifc-lite.d.ts'];
const expectedSourceChanges = [
  'rust/wasm-bindings/Cargo.toml', 'rust/wasm-bindings/src/lib.rs',
  'rust/wasm-bindings/src/csg_work_census.rs',
];
const execRecords = [];
let outRoot;
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--out', '--source6', '--source7'].includes(key) || !argv[i + 1]) throw new Error(`bad argument: ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  if (!result.out || !result.source6 || !result.source7) throw new Error('usage: build-csg-work-bundle.mjs --out DIR --source6 DIR --source7 DIR');
  return result;
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function hashFile(path) { return digest(await readFile(path)); }
async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function parsePorcelain(output) {
  return output.trimEnd().split(/\r?\n/).filter(Boolean).sort();
}
export async function run(id, file, args, options = {}) {
  const result = { id, file, args, cwd: options.cwd, exitCode: null };
  let stdout = '', stderr = '';
  try {
    const child = await exec(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? runTimeoutMs,
      maxBuffer: maxLogBytes,
      windowsHide: true,
    });
    stdout = child.stdout ?? '';
    stderr = child.stderr ?? '';
    result.exitCode = 0;
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    result.exitCode = Number.isInteger(error.code) ? error.code : null;
    result.error = String(error.message).slice(0, 2000);
  }
  const logDir = options.logDir ?? join(outRoot, 'provenance', 'logs');
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${id}.stdout.log`);
  const stderrPath = join(logDir, `${id}.stderr.log`);
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  result.stdout = relative(options.bundleRoot ?? outRoot, stdoutPath).split(sep).join('/');
  result.stdoutSha256 = digest(Buffer.from(stdout));
  result.stderr = relative(options.bundleRoot ?? outRoot, stderrPath).split(sep).join('/');
  result.stderrSha256 = digest(Buffer.from(stderr));
  execRecords.push(result);
  if (result.exitCode !== 0) throw new Error(`${id} failed (${result.exitCode ?? 'exit unavailable'}): ${result.error ?? ''}`);
  return { ...result, rawStdout: stdout };
}

async function git(source, args, id) {
  const r = await run(id, 'git', args, { cwd: source });
  return r;
}
async function treeRows(root) {
  const rows = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        if (bytes.length > maxArtifactBytes) throw new Error(`file exceeds 64 MiB: ${path}`);
        rows.push({ path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: digest(bytes) });
      } else throw new Error(`non-regular bundle entry refused: ${path}`);
    }
  }
  await visit(root);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

async function copyProjectTools(repo) {
  for (const name of ['build-csg-work-bundle.mjs', 'csg-work-diagnostic.mjs', 'run-csg-work-bundle.mjs']) {
    const source = join(repo, 'scripts', 'perf', name);
    if (!(await exists(source))) throw new Error(`required bundle script missing: ${source}`);
    await copyFile(source, join(outRoot, name));
  }
}
async function prepareSource(repo, spec, source) {
  const head = (await git(source, ['rev-parse', 'HEAD'], `git-${spec.name}-head`, repo)).rawStdout.trim();
  if (head !== spec.commit) throw new Error(`${spec.name} source HEAD mismatch: ${head}`);
  const before = (await git(source, ['status', '--porcelain=v1', '--untracked-files=all'], `git-${spec.name}-status-before`, repo)).rawStdout.trimEnd();
  if (before) throw new Error(`${spec.name} source checkout is not clean`);
  const patchPath = join(repo, spec.patch);
  if (await hashFile(patchPath) !== spec.patchSha256) throw new Error(`${spec.name} patch hash mismatch`);
  const lockPath = join(source, 'Cargo.lock');
  const lockSha256 = await hashFile(lockPath);
  const canonicalPkg = (await git(source, ['ls-files', '--', 'packages/wasm/pkg'], `git-${spec.name}-canonical-pkg`)).rawStdout
    .split(/\r?\n/).filter(Boolean);
  const stablePaths = ['rust-toolchain.toml', '.cargo/config.toml', ...canonicalPkg];
  const stablePins = [];
  for (const path of stablePaths) stablePins.push({ path, sha256: await hashFile(join(source, path)) });
  const outputDir = join(source, 'packages', 'wasm', 'pkg-csg-work-census');
  const targetDir = join(dirname(outRoot), `${outRoot.split(sep).pop()}-cargo-target`, spec.name);
  if (await exists(outputDir) || await exists(targetDir)) throw new Error(`${spec.name} output/target path already exists`);
  for (const path of [join(source, 'packages/wasm/pkg/ifc-lite_bg.wasm'), join(source, 'packages/wasm/pkg/ifc-lite.js')]) {
    if (await exists(path)) throw new Error(`${spec.name} canonical runtime already exists: ${path}`);
  }
  await git(source, ['apply', '--check', patchPath], `git-${spec.name}-patch-check`, repo);
  await git(source, ['apply', patchPath], `git-${spec.name}-patch`, repo);
  const changed = (await git(source, ['diff', '--name-only'], `git-${spec.name}-changed`, repo)).rawStdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(expectedSourceChanges.slice(0, 2).sort())) throw new Error(`${spec.name} patch changed unexpected tracked paths`);
  const bridge = join(source, expectedSourceChanges[2]);
  if (!(await exists(bridge))) throw new Error(`${spec.name} bridge module missing after patch`);
  const status = parsePorcelain((await git(source, ['status', '--porcelain=v1', '--untracked-files=all'], `git-${spec.name}-status-patched`, repo)).rawStdout);
  const expectedStatus = [' M rust/wasm-bindings/Cargo.toml', ' M rust/wasm-bindings/src/lib.rs', '?? rust/wasm-bindings/src/csg_work_census.rs'].sort();
  if (JSON.stringify(status) !== JSON.stringify(expectedStatus)) throw new Error(`${spec.name} source state differs from exact patch allowance`);
  const patchedSourcePins = [];
  for (const path of expectedSourceChanges) patchedSourcePins.push({ path, sha256: await hashFile(join(source, path)) });
  return { source, outputDir, targetDir, lockPath, lockSha256, stablePins, patchedSourcePins };
}
async function buildFeature(repo, spec, prepared) {
  const env = { ...process.env };
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTC', 'CARGO_INCREMENTAL', 'FEATURES', 'CARGO_UNSTABLE_BUILD_STD', 'CARGO_BUILD_TARGET', 'CARGO_PROFILE_RELEASE_OPT_LEVEL', 'CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS', 'CARGO_PROFILE_RELEASE_DEBUG', 'CARGO_PROFILE_RELEASE_STRIP', 'CARGO_PROFILE_RELEASE_PANIC']) delete env[key];
  Object.assign(env, {
    CARGO_TARGET_DIR: prepared.targetDir, CARGO_BUILD_JOBS: '2', CARGO_NET_OFFLINE: 'true',
    CARGO_UNSTABLE_BUILD_STD: 'std,panic_abort', DEBUG_GEOMETRY: '0', BUILD_THREADED: '0', BUILD_WIDE: '0',
  });
  const fetchEnv = { ...env };
  delete fetchEnv.CARGO_NET_OFFLINE;
  await run(`cargo-fetch-${spec.name}`, 'rustup', ['run', 'nightly-2025-11-15', 'cargo', 'fetch', '--locked', '--target', 'wasm32-unknown-unknown'], {
    cwd: prepared.source, env: fetchEnv, timeout: runTimeoutMs,
  });
  const args = ['run', 'nightly-2025-11-15', 'wasm-pack', 'build', 'rust/wasm-bindings', '--target', 'web', '--out-dir', '../../packages/wasm/pkg-csg-work-census', '--out-name', 'ifc-lite', '--release', '--', '--features', 'csg-work-census'];
  const command = await run(`wasm-pack-${spec.name}`, 'rustup', args, { cwd: prepared.source, env, timeout: runTimeoutMs });
  if (await hashFile(prepared.lockPath) !== prepared.lockSha256) throw new Error(`${spec.name} Cargo.lock changed during build`);
  for (const pin of prepared.stablePins) if (await hashFile(join(prepared.source, pin.path)) !== pin.sha256) throw new Error(`${spec.name} protected source changed: ${pin.path}`);
  const afterHead = (await git(prepared.source, ['rev-parse', 'HEAD'], `git-${spec.name}-head-after`, repo)).rawStdout.trim();
  const afterChanged = (await git(prepared.source, ['diff', '--name-only'], `git-${spec.name}-changed-after`, repo)).rawStdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (afterHead !== spec.commit || JSON.stringify(afterChanged) !== JSON.stringify(['rust/wasm-bindings/Cargo.toml', 'rust/wasm-bindings/src/lib.rs'])) throw new Error(`${spec.name} source changed beyond intended patch`);
  const allStatus = parsePorcelain((await git(prepared.source, ['status', '--porcelain=v1', '--untracked-files=all'], `git-${spec.name}-status-after`, repo)).rawStdout);
  const expectedTracked = [' M rust/wasm-bindings/Cargo.toml', ' M rust/wasm-bindings/src/lib.rs'];
  const expectedUntracked = ['?? rust/wasm-bindings/src/csg_work_census.rs'];
  const outputPrefix = 'packages/wasm/pkg-csg-work-census/';
  const allowedOutput = new Set([...requiredNames, '.gitignore', 'README.md', 'package.json']);
  const tracked = allStatus.filter((x) => !x.startsWith('?? '));
  const untracked = allStatus.filter((x) => x.startsWith('?? '));
  const other = untracked.filter((x) => {
    if (expectedUntracked.includes(x)) return false;
    const path = x.slice(3);
    return !(path.startsWith(outputPrefix) && allowedOutput.has(path.slice(outputPrefix.length)));
  });
  let sourcePinsChanged = false;
  for (const pin of prepared.patchedSourcePins) if (await hashFile(join(prepared.source, pin.path)) !== pin.sha256) sourcePinsChanged = true;
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTracked.sort()) || other.length || expectedUntracked.some((x) => !untracked.includes(x)) || sourcePinsChanged) {
    throw new Error(`${spec.name} source status changed beyond the explicit patch/output allowance`);
  }
  const artifacts = [];
  for (const name of requiredNames) {
    const path = join(prepared.outputDir, name);
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > maxArtifactBytes) throw new Error(`${spec.name} artifact size refused: ${name}`);
    if (name.endsWith('.wasm') && !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error(`${spec.name} output is not WASM v1`);
    artifacts.push({ name, bytes: bytes.length, sha256: digest(bytes), sourcePath: relative(repo, path).split(sep).join('/') });
  }
  return { command, artifacts, lockSha256: prepared.lockSha256, stablePins: prepared.stablePins, patchedSourcePins: prepared.patchedSourcePins };
}
async function installStockProject(spec, dir) {
  await mkdir(dir, { recursive: true });
  const pkg = { private: true, type: 'module', dependencies: {
    '@ifc-lite/geometry': spec.geometry, '@ifc-lite/wasm': spec.wasm, '@ifc-lite/data': spec.data,
  } };
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await run(`npm-${spec.name}-stock-install`, 'npm', ['install', '--ignore-scripts', '--no-fund'], { cwd: dir, timeout: runTimeoutMs });
  await run(`npm-${spec.name}-signature-audit`, 'npm', ['audit', 'signatures', '--include-attestations', '--ignore-scripts', '--json'], { cwd: dir, timeout: runTimeoutMs });
  for (const [name, version] of [['geometry', spec.geometry], ['wasm', spec.wasm], ['data', spec.data]]) {
    const p = join(dir, 'node_modules', '@ifc-lite', name, 'package.json');
    const found = JSON.parse(await readFile(p, 'utf8')).version;
    if (found !== version) throw new Error(`${spec.name} npm ${name} version mismatch: ${found}`);
  }
  for (const path of ['node_modules/@ifc-lite/geometry/LICENSE', 'node_modules/@ifc-lite/wasm/LICENSE', 'node_modules/@ifc-lite/data/LICENSE']) {
    if (!(await exists(join(dir, path)))) throw new Error(`${spec.name} npm license missing: ${path}`);
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = process.cwd();
  outRoot = resolve(args.out);
  if (await exists(outRoot)) throw new Error(`output directory must be fresh: ${outRoot}`);
  await mkdir(outRoot, { recursive: true });
  await mkdir(join(outRoot, 'provenance'), { recursive: true });
  const deliveryCommit = (await git(repo, ['rev-parse', 'HEAD'], 'git-delivery-head')).rawStdout.trim();
  const sourcePaths = { release6: resolve(repo, args.source6), release7: resolve(repo, args.source7) };
  const repoBuild = [];
  for (const spec of sourceSpecs) {
    const patchPath = join(repo, spec.patch);
    await copyFile(patchPath, join(outRoot, 'provenance', `${spec.name}.patch`));
    const prepared = await prepareSource(repo, spec, sourcePaths[spec.name]);
    const built = await buildFeature(repo, spec, prepared);
    const stockDir = join(outRoot, 'projects', `${spec.name}-stock`);
    const onDir = join(outRoot, 'projects', `${spec.name}-on`);
    await installStockProject(spec, stockDir);
    await cp(stockDir, onDir, { recursive: true, errorOnExist: true });
    for (const artifact of built.artifacts) await copyFile(join(prepared.outputDir, artifact.name), join(onDir, 'node_modules', '@ifc-lite', 'wasm', 'pkg', artifact.name));
    const replaced = new Set(built.artifacts.map((x) => `node_modules/@ifc-lite/wasm/pkg/${x.name}`));
    const stockRows = await treeRows(stockDir);
    const onRows = await treeRows(onDir);
    const stockMap = new Map(stockRows.map((x) => [x.path, x.sha256]));
    const onMap = new Map(onRows.map((x) => [x.path, x.sha256]));
    if (stockMap.size !== onMap.size) throw new Error(`${spec.name} ON copy file set differs from stock`);
    for (const [path, hash] of stockMap) if (!replaced.has(path) && onMap.get(path) !== hash) throw new Error(`${spec.name} ON copy changed non-runtime file: ${path}`);
    for (const artifact of built.artifacts) if (onMap.get(`node_modules/@ifc-lite/wasm/pkg/${artifact.name}`) !== artifact.sha256) throw new Error(`${spec.name} ON runtime artifact mismatch`);
    repoBuild.push({
      name: spec.name, sourceCommit: spec.commit,
      sourceUrl: `https://github.com/LTplus-AG/ifc-lite/tree/${spec.commit}`,
      sourcePatch: `provenance/${spec.name}.patch`, sourcePatchSha256: spec.patchSha256,
      sourcePatchUrl: `https://github.com/LTplus-AG/ifc-lite/blob/${deliveryCommit}/${spec.patch}`,
      cargoLockSha256: built.lockSha256, patchedSources: built.patchedSourcePins, stableSourcePins: built.stablePins,
      command: built.command.args, artifacts: built.artifacts,
    });
  }
  await copyProjectTools(repo);
  await copyFile(join(repo, 'LICENSE'), join(outRoot, 'LICENSE'));
  const projects = {};
  for (const spec of sourceSpecs) for (const mode of ['stock', 'on']) projects[`${spec.name}-${mode}`] = {
    geometryEntry: 'node_modules/@ifc-lite/geometry/dist/index.js',
    wasmGlue: 'node_modules/@ifc-lite/wasm/pkg/ifc-lite.js',
    wasmBinary: 'node_modules/@ifc-lite/wasm/pkg/ifc-lite_bg.wasm',
  };
  const toolchain = [];
  for (const executable of ['rustup', 'wasm-pack', 'npm']) {
    const r = await run(`which-${executable}`, 'which', [executable], { cwd: repo });
    const path = r.rawStdout.trim();
    toolchain.push({ executable, path, bytes: (await stat(path)).size, sha256: await hashFile(path) });
  }
  for (const executable of ['rustc', 'cargo']) {
    const resolved = await run(`rustup-which-${executable}`, 'rustup', ['which', executable, '--toolchain', 'nightly-2025-11-15'], { cwd: repo });
    const path = resolved.rawStdout.trim();
    toolchain.push({ executable, path, bytes: (await stat(path)).size, sha256: await hashFile(path) });
  }
  const bindgenRoot = join(process.env.HOME ?? '', '.cache', '.wasm-pack');
  if (await exists(bindgenRoot)) {
    for (const directory of await readdir(bindgenRoot, { withFileTypes: true })) {
      if (!directory.isDirectory() || !directory.name.startsWith('wasm-bindgen-')) continue;
      const path = join(bindgenRoot, directory.name, 'wasm-bindgen');
      if (await exists(path)) toolchain.push({ executable: 'wasm-bindgen', path, bytes: (await stat(path)).size, sha256: await hashFile(path) });
    }
  }
  const nodePath = process.execPath;
  toolchain.push({ executable: 'node', path: await realpath(nodePath), bytes: (await stat(nodePath)).size, sha256: await hashFile(nodePath), version: process.version });
  await mkdir(join(outRoot, 'provenance'), { recursive: true });
  const manifest = {
    schemaVersion: 'csg-work-bundle-v1', nodeMajor: 24, files: await treeRows(outRoot), projects,
    deliveryCommit, sourceBuilds: repoBuild, toolchain, commands: execRecords.map(({ id, file, args, cwd, exitCode, stdout, stdoutSha256, stderr, stderrSha256 }) => ({ id, file, args, cwd, exitCode, stdout, stdoutSha256, stderr, stderrSha256 })),
    license: { path: 'LICENSE', sha256: await hashFile(join(outRoot, 'LICENSE')) },
    publicSelfCheckExpectedOutputs: { release6: { convertedMeshSha256: sourceSpecs[0].meshSha256 }, release7: { convertedMeshSha256: sourceSpecs[1].meshSha256 }, scope: 'Expected outputs only; builder does not qualify model execution. See separate launcher receipts.' },
  };
  await writeFile(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'BUNDLE_READY', files: manifest.files.length, projects: Object.keys(projects) }));
}
if (isMainEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
