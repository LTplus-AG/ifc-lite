/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, lstatSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inventory, fileHash } from './interleaved-assets.mjs';
import { installedClosure } from './sdk-tools.mjs';
import { compilerFreeze } from './sdk-compiler.mjs';
import { prefetchBindgen, requireBindgen } from './sdk-bindgen.mjs';
import { selectPnpm } from './sdk-pnpm.mjs';
import { refs, fixtures, schedule, limits } from './sdk-plan.mjs';
export const root = resolve(import.meta.dirname, '../..'), output = join(root, 'sdk-results');
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 30000 });
export async function sourceSnapshot(directory, expectedHead) {
  if (git(directory, 'rev-parse', 'HEAD').trim() !== expectedHead
    || git(directory, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error('immutable clean source required');
  const files = {}, links = {};
  for (const row of git(directory, 'ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean)) {
    const [metadata, name] = row.split('\t'), [mode, kind, blob] = metadata.split(' '), path = join(directory, name);
    if (kind !== 'blob') throw new Error('unsupported source submodule');
    const data = mode === '120000' ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    if (createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== blob) throw new Error(`source Git bytes differ: ${name}`);
    if (lstatSync(path).isSymbolicLink()) links[path] = readlinkSync(path);
    files[path] = await fileHash(path);
  }
  return { directory, head: expectedHead, tree: git(directory, 'rev-parse', 'HEAD^{tree}').trim(), files, links };
}
export async function verifySource(snapshot) {
  if (git(snapshot.directory, 'rev-parse', 'HEAD').trim() !== snapshot.head
    || git(snapshot.directory, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error('source head/state changed');
  for (const [path, target] of Object.entries(snapshot.links)) if (readlinkSync(path) !== target) throw new Error('source link changed');
  for (const [path, hash] of Object.entries(snapshot.files)) if (await fileHash(path) !== hash) throw new Error(`source changed: ${path}`);
}
export async function verifyFrozen(provenance) {
  for (const source of provenance.sources) await verifySource(source);
  for (const [path, hash] of Object.entries(provenance.frozenFiles)) if (await fileHash(path) !== hash) throw new Error(`runtime/tool input changed: ${path}`);
  for (const build of Object.values(provenance.builds)) if (!isDeepStrictEqual(await inventory(build.dist), build.assets)) throw new Error('served endpoint assets changed');
  for (const fixture of provenance.fixtures) if (statSync(fixture.file).size !== fixture.bytes || await fileHash(fixture.file) !== fixture.sha256) throw new Error('fixture changed');
}
async function main() {
  mkdirSync(output, { recursive: true });
  const revisions = refs(process.env.BASE_REF, process.env.CANDIDATE_REF);
  const directories = { base: resolve(process.env.BASE_DIR), candidate: resolve(process.env.CANDIDATE_DIR) };
  const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2));
  const mode = process.argv[2];
  if (mode === 'validate-inputs') { write('protocol.json', { revisions, schedule: schedule(), limits, status: 'PROSPECTIVE_NOT_VERDICT' }); return; }
  if (mode === 'select-pnpm') { await selectPnpm(root, output); return; }
  if (mode === 'prefetch-bindgen') { await prefetchBindgen(directories, output); return; }
  if (mode === 'fixtures') {
    for (const option of [[], ['--check']]) execFileSync('node', ['scripts/fixtures/fetch-fixtures.mjs', ...option, ...Object.values(fixtures).map(item => item.path)], { cwd: root, stdio: 'inherit' });
    return;
  }
  if (mode === 'mark-builds') {
    const harnessHead = git(root, 'rev-parse', 'HEAD').trim(), sources = [await sourceSnapshot(root, harnessHead)];
    const pnpmReceiptPath = join(output, 'pnpm-selection.json');
    const pnpmSelection = JSON.parse(readFileSync(pnpmReceiptPath, 'utf8'));
    const bindgenReceiptPath = join(output, 'bindgen-prefetch.json');
    const bindgen = JSON.parse(readFileSync(bindgenReceiptPath, 'utf8'));
    const transform = await requireBindgen(bindgen, directories);
    const frozenFiles = { ...bindgen.files, [bindgenReceiptPath]: await fileHash(bindgenReceiptPath),
      [pnpmReceiptPath]: await fileHash(pnpmReceiptPath), [pnpmSelection.launcher]: pnpmSelection.launcherSha256 }, closures = {};
    const automation = await installedClosure([{ name: '@playwright/test', from: join(root, 'package.json') }]);
    Object.assign(frozenFiles, automation.files);
    for (const arm of ['base', 'candidate']) {
      const directory = directories[arm]; sources.push(await sourceSnapshot(directory, revisions[arm]));
      for (const path of ['rust-toolchain.toml', '.github/actions/setup-wasm-build/action.yml']) {
        if (await fileHash(join(directory, path)) !== await fileHash(join(root, path))) throw new Error('pinned toolchain source differs');
      }
      closures[arm] = await installedClosure([...['vite', 'vite-plugin-wasm', 'vite-plugin-top-level-await'].map(name => ({ name, from: join(directory, 'apps/viewer/package.json') })),
        { name: '@tauri-apps/api', from: join(directory, 'packages/geometry/package.json') },
        { name: 'turbo', from: join(directory, 'package.json') },
        ...['geometry', 'data', 'encoding', 'wasm-lifecycle'].map(name => ({ name: 'typescript', from: join(directory, 'packages', name, 'package.json') }))]);
      Object.assign(frozenFiles, closures[arm].files);
    }
    if (!isDeepStrictEqual(closures.base.normalized, closures.candidate.normalized)) throw new Error('installed compiler/plugin bytes differ');
    const compiler = await compilerFreeze(root);
    if (compiler.binaries.pnpm !== pnpmSelection.executable || await fileHash(compiler.binaries.pnpm) !== pnpmSelection.executableSha256) throw new Error('actual pnpm tool selection changed');
    Object.assign(frozenFiles, compiler.files);
    const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 30000 }).trim();
    write('build-start.json', { revisions, directories, sources, frozenFiles, closures, automation, compiler, bindgen, transform, pnpmSelection,
      timestampMs: Date.now(), harnessHead, environment: { node: process.version, nodeExecutable: process.execPath,
        chromeExecutable: '/opt/google/chrome/chrome', chrome: command('/opt/google/chrome/chrome', ['--version']),
        rust: command('rustc', ['--version']), wasmPack: command('wasm-pack', ['--version']), pnpm: command('pnpm', ['--version']),
        cpu: readFileSync('/proc/cpuinfo', 'utf8'), memory: readFileSync('/proc/meminfo', 'utf8') } });
    return;
  }
  if (mode !== 'freeze') throw new Error('unknown preparation mode');
  const start = JSON.parse(readFileSync(join(output, 'build-start.json'), 'utf8')), builds = {};
  for (const arm of ['base', 'candidate']) {
    const directory = start.directories[arm], wasm = join(directory, 'packages/wasm/pkg/ifc-lite_bg.wasm');
    if (statSync(wasm).mtimeMs < start.timestampMs) throw new Error('source WASM predates build start');
    const receiptPath = join(output, `${arm}-source-build.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.status !== 'complete-source-build' || receipt.exit !== 0 || receipt.revision !== start.revisions[arm]
      || receipt.wasmSha256 !== await fileHash(wasm) || await fileHash(receipt.logPath) !== receipt.logSha256) throw new Error('actual source-build receipt/log/WASM differs');
    start.frozenFiles[receiptPath] = await fileHash(receiptPath); start.frozenFiles[receipt.logPath] = receipt.logSha256;
    const dist = join(output, `${arm}-endpoint`), assets = await inventory(dist), wasmSha256 = receipt.wasmSha256;
    if (!assets.some(asset => asset.path.endsWith('.wasm') && asset.sha256 === wasmSha256)
      || !assets.some(asset => /geometry\.worker.*\.js$/.test(asset.path))) throw new Error('fresh WASM/worker not served');
    builds[arm] = { revision: start.revisions[arm], directory, dist, assets, wasmSha256, sourceBuild: receipt };
    for (const name of ['ifc-lite.js', 'ifc-lite_bg.wasm', 'ifc-lite.d.ts']) start.frozenFiles[join(directory, 'packages/wasm/pkg', name)] = await fileHash(join(directory, 'packages/wasm/pkg', name));
  }
  const manifest = JSON.parse(readFileSync(join(root, 'tests/models/manifest.json'), 'utf8'));
  const inputs = Object.entries(fixtures).map(([family, fixture]) => {
    const entry = manifest.files.find(item => item.path === fixture.path);
    if (!entry || entry.sha256 !== fixture.sha256 || entry.size !== fixture.bytes) throw new Error('fixed fixture manifest differs');
    return { family, ...fixture, file: join(root, 'tests/models', fixture.path), publicRelease: manifest.release_tag, publicBaseURL: manifest.base_url };
  });
  const provenance = { ...start, builds, fixtures: inputs, scope: 'Fresh source-built SDK endpoint; no browser admission or speed verdict' };
  await verifyFrozen(provenance); write('provenance.json', provenance);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
