#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Package existing builds only; never compile, download or execute SDK code.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRetainedBrowserAssets } from './stage-retained-browser-assets.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(path, parent) {
  const delta = relative(parent, path);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(delta));
}
async function regular(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected regular file: ${path}`);
  const bytes = await readFile(path);
  if (!bytes.length) throw new Error(`Empty asset: ${path}`);
  return bytes;
}
async function inventory(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else {
      const bytes = await regular(join(root, path));
      files.push({ path: path.split('\\').join('/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return files;
}
async function absent(out) {
  try { await lstat(out); throw new Error(`Output already exists: ${out}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// repoRoot is a test seam, as in stageRetainedBrowserAssets; never a CLI option.
// toolchainNotices inventories supplied runtime/linker notices, not an audit or
// an assertion that the inventory is complete. No compiler license is guessed.
export async function stageCliRetainedEngine({ build, sdk, pkgRetained, out, toolchainNotices = [], repoRoot = ROOT }) {
  for (const [name, value] of Object.entries({ build, sdk, pkgRetained, out })) {
    if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  [build, sdk, pkgRetained, repoRoot] = await Promise.all([build, sdk, pkgRetained, repoRoot].map(path => realpath(path)));
  out = join(await realpath(dirname(out)), basename(out));
  for (const input of [build, sdk, pkgRetained, join(repoRoot, 'native/smlib-adapter')]) {
    if (inside(out, input) || inside(input, out)) throw new Error('Output must not overlap engine inputs');
  }
  await absent(out);
  for (const name of ['ifc-lite.js', 'ifc-lite.d.ts', 'package.json']) await regular(join(pkgRetained, name));
  const pkg = JSON.parse(await readFile(join(pkgRetained, 'package.json'), 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid pkg-retained package.json');
  const wasm = await regular(join(pkgRetained, 'ifc-lite_bg.wasm'));
  if (!wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('pkg-retained is not a wasm version-1 binary');
  const pkgFiles = await inventory(pkgRetained);
  const notices = new Map();
  for (const { name, path } of toolchainNotices) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || notices.has(name)) throw new Error('Invalid or duplicate toolchain notice name');
    if (!isAbsolute(path)) throw new Error('Toolchain notice path must be absolute');
    notices.set(name, await regular(path));
  }
  const temporary = await mkdtemp(join(dirname(out), '.cli-retained-stage-'));
  try {
    const browser = await stageRetainedBrowserAssets({ build, sdk, out: join(temporary, 'smlib'), repoRoot });
    const copy = async (source, target) => {
      const bytes = await regular(source);
      await mkdir(dirname(join(temporary, target)), { recursive: true });
      await writeFile(join(temporary, target), bytes, { flag: 'wx' });
    };
    for (const { path } of pkgFiles) await copy(join(pkgRetained, path), `pkg-retained/${path}`);
    // wasm-pack's web package relies on its repository parent's ESM scope.
    // An engine outside that checkout needs its own scope on Node 20.6 too.
    await writeFile(join(temporary, 'pkg-retained/package.json'), `${JSON.stringify({ ...pkg, type: 'module' }, null, 2)}\n`);
    for (const name of ['client.mjs', 'worker.mjs', 'hooks.mjs']) {
      await copy(join(repoRoot, 'native/smlib-adapter/node', name), `smlib/node/${name}`);
    }
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await copy(join(temporary, 'smlib', name), `LICENSES/SMLib/${name}`);
    }
    await copy(join(repoRoot, 'LICENSE'), 'LICENSES/ifc-lite/LICENSE');
    const toolchainInventory = [];
    for (const [name, bytes] of [...notices].sort(([a], [b]) => a.localeCompare(b))) {
      const path = `LICENSES/toolchain/${name}`;
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await writeFile(join(temporary, path), bytes, { flag: 'wx' });
      toolchainInventory.push({ name, path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = {
      format: 'ifc-lite.retained-engine/1',
      qualified: false, buildAttestation: false,
      sdk: browser.sdk, capabilities: null,
      toolchainNotices: toolchainInventory,
      note: 'Hashes identify supplied assets, not build provenance, numerical qualification or notice completeness.',
      assets: await inventory(temporary),
    };
    await writeFile(join(temporary, 'engine-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await absent(out);
    await rename(temporary, out);
    return { manifest, manifestSha256: sha256(await readFile(join(out, 'engine-manifest.json'))) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  const options = { toolchainNotices: [] };
  const keys = { '--build': 'build', '--sdk': 'sdk', '--pkg-retained': 'pkgRetained', '--out': 'out' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!value || (!keys[key] && key !== '--toolchain-notice')) {
      throw new Error('Usage: node scripts/stage-cli-retained-engine.mjs --build ABS --sdk ABS --pkg-retained ABS --out ABS [--toolchain-notice NAME=ABS]...');
    }
    if (key === '--toolchain-notice') {
      const separator = value.indexOf('=');
      if (separator < 1) throw new Error('Expected --toolchain-notice NAME=ABS');
      options.toolchainNotices.push({ name: value.slice(0, separator), path: value.slice(separator + 1) });
    } else options[keys[key]] = value;
  }
  const { manifest, manifestSha256 } = await stageCliRetainedEngine(options);
  console.log(`Staged ${manifest.assets.length} assets in ${options.out}; manifest sha256 ${manifestSha256}; packaging only.`);
}
if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
