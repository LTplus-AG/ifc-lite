#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Explicit packaging only: never fetches, builds, imports or qualifies the SDK.
import { readFile, readdir, lstat, realpath, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['client', 'worker', 'module', 'sweep', 'sweep-contract',
  'contract', 'mesh-witness', 'region-recipes'];
const GENERATED = ['ifclite_smlib_browser.mjs', 'ifclite_smlib_browser.wasm'];
const LICENSES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(path, parent) {
  const delta = relative(parent, path);
  return delta === '' || (delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\') && !isAbsolute(delta));
}
function git(sdk, ...args) {
  return execFileSync('git', ['-C', sdk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function regular(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected regular file: ${path}`);
  const bytes = await readFile(path);
  if (!bytes.length) throw new Error(`Empty asset: ${path}`);
  return bytes;
}
async function sourceFiles(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await regular(join(root, path));
      files.push({ path: path.split('\\').join('/'), bytes: bytes.length, sha256: digest(bytes) });
    } else throw new Error(`Nonregular adapter source: ${path}`);
  }
  return files;
}
function cacheValue(cache, name) {
  const line = cache.split(/\r?\n/).find(value => value.startsWith(`${name}:`));
  if (!line || !line.includes('=')) throw new Error(`Missing CMake cache field ${name}`);
  return line.slice(line.indexOf('=') + 1);
}

// repoRoot is supplied only by the packaging invariant tests; not a CLI option.
export async function stageRetainedBrowserAssets({ build, sdk, out, repoRoot = ROOT }) {
  for (const [name, value] of Object.entries({ build, sdk, out })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  const adapter = await realpath(join(repoRoot, 'native/smlib-adapter'));
  build = await realpath(build);
  sdk = await realpath(sdk);
  out = join(await realpath(dirname(out)), resolve(out).split('/').at(-1));
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
  const assets = new Map();
  const assetManifest = [];
  function add(name, bytes, origin) {
    assets.set(name, bytes);
    assetManifest.push({ path: name, bytes: bytes.length, sha256: digest(bytes), origin });
  }
  for (const module of MODULES) {
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
  const manifest = {
    format: 'ifclite-retained-browser-assets-v1',
    purpose: 'explicit-packaging-only', qualified: false,
    buildAttestation: false,
    note: 'Binary hashes identify supplied build outputs; source hashes do not prove how those outputs were compiled.',
    sdk: { revision, cleanPaths: protectedPaths },
    buildDirectory: build, sdkDirectory: sdk,
    adapterSources: await sourceFiles(adapter), assets: assetManifest,
  };
  // All reads and checks precede publication. Refuse to replace any existing tree.
  const temporary = await mkdtemp(join(dirname(out), '.smlib-stage-'));
  try {
    for (const [name, bytes] of assets) await writeFile(join(temporary, name), bytes, { flag: 'wx' });
    await writeFile(join(temporary, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    // Recheck before rename; callers must serialize staging into a given destination.
    try { await lstat(out); throw new Error(`Output appeared during staging: ${out}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}

async function main(args) {
  const options = { out: join(ROOT, 'apps/viewer/public/smlib') };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!['build', 'sdk', 'out'].includes(key) || !args[i + 1] || !args[i].startsWith('--')) {
      throw new Error('Usage: node scripts/stage-retained-browser-assets.mjs --build ABS --sdk ABS [--out ABS]');
    }
    options[key] = args[i + 1];
  }
  const manifest = await stageRetainedBrowserAssets(options);
  console.log(`Staged ${manifest.assets.length} assets in ${options.out}; packaging only, not qualification.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
