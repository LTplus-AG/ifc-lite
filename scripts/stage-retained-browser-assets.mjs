#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Explicit packaging only: never fetches, builds, imports or qualifies the SDK.
import { lstat, realpath, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { digest, regular, files, readWithin, row, dependencies, NOTICES, EMSCRIPTEN_REVISION } from './lib/retained-asset-contract.mjs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = ['ifclite_smlib_browser.mjs', 'ifclite_smlib_browser.wasm'];
const LICENSES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
function inside(path, parent) {
  const delta = relative(parent, path);
  return delta === '' || (delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\') && !isAbsolute(delta));
}
function git(sdk, ...args) {
  return execFileSync('git', ['-C', sdk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cacheValue(cache, name) {
  const line = cache.split(/\r?\n/).find(value => value.startsWith(`${name}:`));
  if (!line || !line.includes('=')) throw new Error(`Missing CMake cache field ${name}`);
  return line.slice(line.indexOf('=') + 1);
}

// repoRoot is supplied only by the packaging invariant tests; not a CLI option.
export async function stageRetainedBrowserAssets({ build, sdk, engine, emscripten, inputs, record, out, repoRoot = ROOT }) {
  for (const [name, value] of Object.entries({ build, sdk, engine, emscripten, ...(record ? { record } : { out, inputs }) })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  if (record && (inputs || out)) throw new Error('--record is exclusive with --inputs/--out');
  const adapter = await realpath(join(repoRoot, 'native/smlib-adapter'));
  build = await realpath(build);
  sdk = await realpath(sdk);
  engine = await realpath(engine);
  emscripten = await realpath(emscripten);
  out = out ?? record;
  out = join(await realpath(dirname(out)), resolve(out).split('/').at(-1));
  if ([engine, emscripten].some(path => inside(out, path) || inside(path, out))) throw new Error('Output overlaps input');
  if (inside(out, build) || inside(out, sdk) || inside(out, adapter) ||
      inside(build, out) || inside(sdk, out) || inside(adapter, out)) {
    throw new Error('Output must not overlap SDK, build or adapter sources');
  }
  try {
    await lstat(out);
    throw new Error(`Output already exists; choose a new directory or explicitly remove the old staged bundle: ${out}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cmake = await regular(join(adapter, 'CMakeLists.txt'));
  const revision = cmake.toString().match(/set\(IFCLITE_SMLIB_REVISION ([a-f0-9]{40})\)/)?.[1];
  if (!revision || git(sdk, 'rev-parse', 'HEAD') !== revision) throw new Error('SDK revision differs from adapter pin');
  const protectedPaths = ['source/SMLib', 'source/SM_API', ...LICENSES];
  if (git(sdk, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', ...protectedPaths)) {
    throw new Error('SDK kernel/API or license files are not clean');
  }
  for (const path of LICENSES) git(sdk, 'ls-files', '--error-unmatch', '--', path);
  const cache = (await regular(join(build, 'CMakeCache.txt'))).toString();
  if (await realpath(cacheValue(cache, 'CMAKE_HOME_DIRECTORY')) !== adapter ||
      await realpath(cacheValue(cache, 'SMLIB_SOURCE')) !== sdk) {
    throw new Error('CMake build is bound to a different adapter or SDK');
  }
  if (await realpath(cacheValue(cache, 'CMAKE_TOOLCHAIN_FILE')) !==
      await realpath(join(emscripten, 'cmake/Modules/Platform/Emscripten.cmake'))) {
    throw new Error('CMake toolchain differs from supplied Emscripten input');
  }
  const assets = new Map();
  const assetManifest = [];
  function add(name, bytes, origin) {
    assets.set(name, bytes);
    assetManifest.push({ path: name, bytes: bytes.length, sha256: digest(bytes), origin });
  }
  const modules = cmake.toString().match(/foreach\(module\s+([^)]+)\)/)?.[1].trim().split(/\s+/);
  if (!modules || modules.some(name => !/^[a-z-]+$/.test(name)) || new Set(modules).size !== modules.length) {
    throw new Error('Unsupported CMake browser module inventory');
  }
  for (const module of modules) {
    const name = `${module}.mjs`;
    const canonical = await regular(join(adapter, 'browser', name));
    const configured = await regular(join(build, name));
    if (!canonical.equals(configured)) throw new Error(`Stale configured module ${name}; reconfigure the adapter build`);
    add(name, configured, `native/smlib-adapter/browser/${name}`);
  }
  for (const name of GENERATED) add(name, await regular(join(build, name)), `existing-build/${name}`);
  if (!assets.get(GENERATED[1]).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Generated adapter is not a wasm version-1 binary');
  }
  for (const name of LICENSES) add(name, await regular(join(sdk, name)), `pinned-sdk/${name}`);
  const driverPaths = [];
  for (const name of await files(engine)) {
    if (['package.json', 'README.md', '.gitignore', '.npmignore'].includes(name) || name.endsWith('.d.ts')) continue;
    if (!/\.(js|mjs|wasm)$/.test(name)) throw new Error(`Unexpected retained engine asset ${name}`);
    const bytes = await readWithin(engine, name);
    if (name.startsWith('snippets/')) {
      const sourcePath = name.match(/^snippets\/[^/]+\/(js\/.+)$/)?.[1];
      if (!sourcePath || !bytes.equals(await readWithin(join(repoRoot, 'rust/wasm-bindings'), sourcePath))) {
        throw new Error(`Stale or unknown retained snippet ${name}`);
      }
      if (sourcePath === 'js/retained-driver.mjs') driverPaths.push(`pkg-retained/${name}`);
    }
    add(`pkg-retained/${name}`, bytes, `retained-engine/${name}`);
  }
  for (const name of ['ifc-lite.js', 'ifc-lite_bg.wasm']) {
    if (!assets.has(`pkg-retained/${name}`)) throw new Error(`Missing retained engine ${name}`);
  }
  for (const [name, bytes] of assets) {
    if (name.endsWith('.wasm') && !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
      throw new Error(`Asset is not a wasm version-1 binary: ${name}`);
    }
  }
  for (const [name, sha256] of NOTICES) {
    const bytes = await readWithin(emscripten, name);
    if (digest(bytes) !== sha256) throw new Error(`Pinned Emscripten notice mismatch: ${name}`);
    add(`notices/emscripten/${name}`, bytes, `emscripten@${EMSCRIPTEN_REVISION}/${name}`);
  }
  add('notices/ifc-lite/LICENSE', await regular(join(repoRoot, 'LICENSE')), 'IFC-Lite/MPL-2.0');
  if (driverPaths.length !== 1) throw new Error('Missing or ambiguous canonical retained driver snippet');
  const closure = dependencies(assets, driverPaths);
  const reachable = new Set(['pkg-retained/ifc-lite.js']);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of closure) if (reachable.has(edge.from) && !reachable.has(edge.to)) {
      reachable.add(edge.to); changed = true;
    }
  }
  if (!reachable.has(driverPaths[0])) throw new Error('Retained engine does not import its canonical driver');
  const sourceNames = execFileSync('git', ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'native/smlib-adapter', 'rust', 'scripts/build-wasm.sh', 'scripts/stage-retained-browser-assets.mjs',
    'scripts/lib/retained-asset-contract.mjs', 'scripts/lib/retained-publish.py',
    'scripts/lib/retained-loader-syntax.mjs', 'scripts/lib/retained-loader-dependencies.mjs',
    'scripts/lib/retained-loader-profiles.json', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'],
    { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  if (!sourceNames.length) throw new Error('Missing tracked source inventory');
  const sources = [];
  for (const name of sourceNames) sources.push(row(name, await readWithin(repoRoot, name, true)));
  assetManifest.sort((a, b) => a.path < b.path ? -1 : 1);
  const inventory = { format: 'ifclite-retained-inputs-v1', cmakeCacheSha256: digest(Buffer.from(cache)), sdkRevision: revision,
    emscriptenNoticeRevision: EMSCRIPTEN_REVISION, sources, assets: assetManifest, dependencies: closure };
  if (record) {
    await writeFile(record, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    return inventory;
  }
  const recorded = JSON.parse((await regular(inputs)).toString());
  if (JSON.stringify(recorded) !== JSON.stringify(inventory)) {
    throw new Error('Input inventory mismatch: missing, stale, tampered or wrong-source assets; review and rebuild before recording new inputs');
  }
  const manifest = {
    format: 'ifclite-retained-browser-assets-v2',
    purpose: 'explicit-packaging-only', qualified: false,
    buildAttestation: false,
    note: 'Binary hashes identify supplied build outputs; source hashes do not prove how those outputs were compiled.',
    sdk: { revision, cleanPaths: protectedPaths },
    releaseAuthorized: false, licenceClearance: false,
    inputInventorySha256: digest(Buffer.from(JSON.stringify(inventory))),
    emscriptenNoticeRevision: EMSCRIPTEN_REVISION, dependencies: closure, sources,
    assets: assetManifest,
  };
  // All reads and checks precede publication. Refuse to replace any existing tree.
  const temporary = await mkdtemp(join(dirname(out), '.smlib-stage-'));
  try {
    for (const [name, bytes] of assets) {
      await mkdir(dirname(join(temporary, name)), { recursive: true });
      await writeFile(join(temporary, name), bytes, { flag: 'wx' });
    }
    await writeFile(join(temporary, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    // A single Linux renameat2(RENAME_NOREPLACE), including empty destinations.
    // Node rename() has no no-replace flag; unsupported hosts fail closed.
    execFileSync('python3', [join(ROOT, 'scripts/lib/retained-publish.py'), temporary, out],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['build', 'sdk', 'engine', 'emscripten', 'inputs', 'record', 'out'].includes(key) || !args[i + 1] || !args[i].startsWith('--')) {
      throw new Error('Usage: node scripts/stage-retained-browser-assets.mjs --build ABS --sdk ABS --engine ABS --emscripten ABS (--record ABS | --inputs ABS --out ABS)');
    }
    options[key] = args[i + 1];
  }
  const manifest = await stageRetainedBrowserAssets(options);
  console.log(`${options.record ? 'Recorded inputs for' : 'Staged'} ${manifest.assets.length} assets in ${options.record ?? options.out}; packaging only, not qualification.`);
}
if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
