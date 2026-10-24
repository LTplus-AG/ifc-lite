// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyRetainedAssets, NOTICES } from './lib/retained-asset-contract.mjs';
import { stageRetainedBrowserAssets } from './stage-retained-browser-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retained-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk'), build = join(root, 'build'), repoRoot = join(root, 'repo');
  const adapter = join(repoRoot, 'native/smlib-adapter');
  await mkdir(join(adapter, 'browser'), { recursive: true });
  await mkdir(build);
  await mkdir(join(sdk, 'source/SMLib'), { recursive: true });
  await mkdir(join(sdk, 'source/SM_API'), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'source/SMLib/kernel.cpp', 'source/SM_API/api.cpp']) {
    await writeFile(join(sdk, name), `packaging fixture ${name}\n`);
  }
  const git = (...args) => execFileSync('git', ['-C', sdk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Packaging test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Packaging fixture');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(adapter, 'CMakeLists.txt'), `set(IFCLITE_SMLIB_REVISION ${revision})\nforeach(module client worker module contract sweep sweep-contract dependency-contract normal-contract)\n`);
  // Use actual canonical browser modules, not an imitation transport implementation.
  for (const name of ['client', 'worker', 'module', 'contract', 'sweep', 'sweep-contract', 'dependency-contract', 'normal-contract']) {
    const bytes = await readFile(resolve(`native/smlib-adapter/browser/${name}.mjs`));
    await writeFile(join(adapter, `browser/${name}.mjs`), bytes);
    await writeFile(join(build, `${name}.mjs`), bytes);
  }
  await writeFile(join(build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${adapter}\nSMLIB_SOURCE:UNINITIALIZED=${sdk}\n`);
  // Valid empty WASM module: packaging witness only, never a numerical SDK claim.
  await writeFile(join(build, 'ifclite_smlib_browser.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(join(build, 'ifclite_smlib_browser.mjs'), 'export default function packagingFixture() {}\n');
  const engine = join(root, 'engine'), emscripten = join(root, 'emscripten');
  await mkdir(join(engine, 'snippets/fixture/js'), { recursive: true });
  await mkdir(join(repoRoot, 'rust/wasm-bindings/js'), { recursive: true });
  const driver = await readFile(resolve('rust/wasm-bindings/js/retained-driver.mjs'));
  await writeFile(join(engine, 'snippets/fixture/js/retained-driver.mjs'), driver);
  await writeFile(join(repoRoot, 'rust/wasm-bindings/js/retained-driver.mjs'), driver);
  await writeFile(join(engine, 'ifc-lite.js'), "import './snippets/fixture/js/retained-driver.mjs'; export const wasm = new URL('ifc-lite_bg.wasm', import.meta.url);\n");
  await writeFile(join(engine, 'ifc-lite_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await cp(resolve('scripts/fixtures/retained-notices'), emscripten, { recursive: true });
  await mkdir(join(emscripten, 'cmake/Modules/Platform'), { recursive: true });
  await writeFile(join(emscripten, 'cmake/Modules/Platform/Emscripten.cmake'), 'fixture toolchain');
  await writeFile(join(build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${adapter}\nSMLIB_SOURCE:UNINITIALIZED=${sdk}\nCMAKE_TOOLCHAIN_FILE:FILEPATH=${emscripten}/cmake/Modules/Platform/Emscripten.cmake\n`);
  await writeFile(join(repoRoot, 'LICENSE'), 'fixture MPL text');
  execFileSync('git', ['-C', repoRoot, 'init', '--quiet']);
  execFileSync('git', ['-C', repoRoot, 'add', '.']);
  const options = { build, sdk, repoRoot, engine, emscripten, inputs: join(root, 'inputs.json'), out: join(root, 'published') };
  await stageRetainedBrowserAssets({ ...options, record: options.inputs, inputs: undefined, out: undefined });
  return options;
}

test('stages exact bytes, licenses and checkable hashes without executing generated modules', async t => {
  const options = await fixture(t);
  const manifest = await stageRetainedBrowserAssets(options);
  assert.equal(manifest.qualified, false);
  assert.equal(manifest.buildAttestation, false);
  assert.equal(manifest.assets.length, 21);
  await verifyRetainedAssets(options.out, options.inputs);
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(options.out, asset.path));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  assert.deepEqual(JSON.parse(await readFile(join(options.out, 'asset-manifest.json'), 'utf8')), manifest);
  await assert.rejects(stageRetainedBrowserAssets(options), /already exists/);
});

test('missing generated binary or stale configured modules publish no partial output', async t => {
  const options = await fixture(t);
  const binary = join(options.build, 'ifclite_smlib_browser.wasm');
  const original = await readFile(binary);
  await rm(binary);
  await assert.rejects(stageRetainedBrowserAssets(options), /ENOENT/);
  await assert.rejects(access(options.out), /ENOENT/);
  await writeFile(binary, original);
  await writeFile(join(options.build, 'client.mjs'), 'stale transport');
  await assert.rejects(stageRetainedBrowserAssets(options), /Stale configured module client/);
  await assert.rejects(access(options.out), /ENOENT/);
});

test('refuses changed SDK source, non-WASM output, foreign CMake source and source-overlap destination', async t => {
  const options = await fixture(t);
  const kernel = join(options.sdk, 'source/SMLib/kernel.cpp');
  const source = await readFile(kernel);
  await writeFile(kernel, 'modified SDK');
  await assert.rejects(stageRetainedBrowserAssets(options), /not clean/);
  await writeFile(kernel, source);
  await writeFile(join(options.build, 'ifclite_smlib_browser.wasm'), 'not wasm');
  await assert.rejects(stageRetainedBrowserAssets(options), /not a wasm/);
  await assert.rejects(stageRetainedBrowserAssets({ ...options, out: join(options.sdk, 'output') }), /overlap/);
  await assert.rejects(stageRetainedBrowserAssets({ ...options, out: join(options.sdk, '..hidden') }), /overlap/);
  await writeFile(join(options.build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${options.sdk}\nSMLIB_SOURCE:PATH=${options.sdk}\n`);
  await assert.rejects(stageRetainedBrowserAssets(options), /different adapter or SDK/);
});

// #7955 BROWSER01: packaging must carry the executable dependency witness.
test('dependency witness is staged and stale witness refuses publication', async t => {
  const options = await fixture(t);
  await writeFile(join(options.build, 'dependency-contract.mjs'), 'stale witness');
  await assert.rejects(stageRetainedBrowserAssets(options), /Stale configured module dependency-contract/);
  await assert.rejects(access(options.out), /ENOENT/);
});

// #7955: exercise delivered bytes, not script text or a mocked filesystem.
test('inventory refuses binary tampering, wrong source and missing engine without partial output', async t => {
  for (const mutate of [
    o => writeFile(join(o.engine, 'ifc-lite_bg.wasm'), Buffer.from([0,97,115,109,1,0,0,0,0])),
    o => writeFile(join(o.repoRoot, 'native/smlib-adapter/CMakeLists.txt'), 'wrong source'),
    o => rm(join(o.engine, 'ifc-lite.js')),
    o => writeFile(join(o.engine, 'snippets/fixture/js/retained-driver.mjs'), 'wrong driver'),
    o => writeFile(join(o.emscripten, NOTICES[0][0]), 'tampered notice'),
    o => writeFile(join(o.build, 'ifclite_smlib_browser.mjs'), "import './new-runtime.mjs';"),
  ]) {
    const o = await fixture(t);
    await mutate(o);
    await assert.rejects(stageRetainedBrowserAssets(o));
    await assert.rejects(access(o.out), /ENOENT/);
    assert.equal((await readdir(join(o.out, '..'))).filter(n => n.startsWith('.smlib-stage-')).length, 0);
  }
});

test('staged scanner rejects omitted, extra, tampered assets and altered manifest', async t => {
  for (const mutate of [
    o => rm(join(o.out, 'normal-contract.mjs')),
    o => writeFile(join(o.out, 'extra.mjs'), 'export {};'),
    o => writeFile(join(o.out, 'pkg-retained/ifc-lite.js'), 'tampered'),
    o => writeFile(join(o.out, 'asset-manifest.json'), '{}'),
  ]) {
    const o = await fixture(t);
    await stageRetainedBrowserAssets(o);
    await mutate(o);
    await assert.rejects(verifyRetainedAssets(o.out, o.inputs));
  }
});

test('deterministic manifests and concurrent no-replace publication', async t => {
  const o = await fixture(t);
  const results = await Promise.allSettled([stageRetainedBrowserAssets(o), stageRetainedBrowserAssets(o)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await verifyRetainedAssets(o.out, o.inputs);
  const other = { ...o, out: join(o.out, '../second') };
  await stageRetainedBrowserAssets(other);
  assert.deepEqual(await readFile(join(o.out, 'asset-manifest.json')), await readFile(join(other.out, 'asset-manifest.json')));
  const empty = join(o.out, '../existing');
  await mkdir(empty);
  await assert.rejects(stageRetainedBrowserAssets({ ...o, out: empty }), /already exists/);
  assert.deepEqual(await readdir(empty), []);
});

test('missing new runtime import and escaping snippet symlink refuse even input recording', async t => {
  const o = await fixture(t);
  await writeFile(join(o.engine, 'ifc-lite.js'), "export * from './missing-extensionless';");
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record: join(o.out, '../fresh.json'), inputs: undefined, out: undefined }), /dependency/);
  await rm(join(o.engine, 'ifc-lite.js'));
  await symlink(join(o.build, 'client.mjs'), join(o.engine, 'ifc-lite.js'));
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record: join(o.out, '../fresh.json'), inputs: undefined, out: undefined }), /Nonregular/);
});

test('new CMake module is delivered with its actual import closure (#7955)', async t => {
  const o = await fixture(t);
  const cmake = join(o.repoRoot, 'native/smlib-adapter/CMakeLists.txt');
  await writeFile(cmake, (await readFile(cmake, 'utf8')).replace(' normal-contract)', ' normal-contract extra-runtime)'));
  for (const base of [o.build, join(o.repoRoot, 'native/smlib-adapter/browser')]) {
    await writeFile(join(base, 'extra-runtime.mjs'), "export { request } from './contract.mjs';\n");
  }
  const inputs = join(o.out, '../new-inputs.json');
  await stageRetainedBrowserAssets({ ...o, record: inputs, inputs: undefined, out: undefined });
  const manifest = await stageRetainedBrowserAssets({ ...o, inputs });
  assert.ok(manifest.assets.some(asset => asset.path === 'extra-runtime.mjs'));
  assert.ok(manifest.dependencies.some(edge => edge.from === 'extra-runtime.mjs' && edge.to === 'contract.mjs'));
  await verifyRetainedAssets(o.out, inputs);
});

test('source changes and unresolved dynamic imports cannot reuse or record an inventory (#7955)', async t => {
  const o = await fixture(t);
  await writeFile(join(o.repoRoot, 'rust/new-source.rs'), '// new source\n');
  await assert.rejects(stageRetainedBrowserAssets(o), /inventory mismatch/);
  await writeFile(join(o.engine, 'ifc-lite.js'), 'const target = globalThis.asset; import(target);');
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record: join(o.out, '../new.json'), inputs: undefined, out: undefined }), /Unresolved dynamic import/);
  await assert.rejects(access(o.out), /ENOENT/);
});

test('publication syscall refuses even an empty destination without changing either tree (#7955)', async t => {
  const o = await fixture(t);
  const source = join(o.out, '../prepared');
  await mkdir(source);
  await writeFile(join(source, 'complete'), 'owned output');
  await mkdir(o.out);
  assert.throws(() => execFileSync('python3', [resolve('scripts/lib/retained-publish.py'), source, o.out], { stdio: 'pipe' }));
  assert.equal(await readFile(join(source, 'complete'), 'utf8'), 'owned output');
  assert.deepEqual(await readdir(o.out), []);
});
