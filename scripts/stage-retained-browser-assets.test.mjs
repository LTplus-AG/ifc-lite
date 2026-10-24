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

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sdkSnapshot(adapter, sdk, build, revision) {
  const names = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'source/SM_API/api.cpp', 'source/SMLib/kernel.cpp'].sort();
  const input = await Promise.all(names.map(async name => [name, hash(await readFile(join(sdk, name)))]));
  const patch = Buffer.from('fixture patch identity');
  const modified = Buffer.from('fixture modified kernel with explicit change notice');
  const pins = { schema: 1, id: 'imprint-status-v1', upstreamRevision: revision,
    selection: ['source/SMLib', 'source/SM_API', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    fileCount: names.length, inputInventorySha256: hash(JSON.stringify(input)),
    path: 'source/SMLib/kernel.cpp', inputSha256: input.find(([name]) => name.endsWith('kernel.cpp'))[1],
    outputSha256: hash(modified), patchSha256: hash(patch) };
  await mkdir(join(adapter, 'patches'));
  const pinsBytes = Buffer.from(JSON.stringify(pins));
  const preparer = Buffer.from('# fixture preparer identity');
  await writeFile(join(adapter, 'patches/imprint-status-v1.json'), pinsBytes);
  await writeFile(join(adapter, 'patches/imprint-status-v1.patch'), patch);
  await writeFile(join(adapter, 'prepare_sdk.py'), preparer);
  const root = join(build, 'ifclite-sdk/imprint-status-v1');
  for (const name of names) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), name === pins.path ? modified : await readFile(join(sdk, name)));
  }
  const outputFiles = Object.fromEntries(input); outputFiles[pins.path] = pins.outputSha256;
  const receipt = { schema: 1, upstreamRevision: revision, upstreamInventorySha256: pins.inputInventorySha256,
    preparerSha256: hash(preparer), pinsSha256: hash(pinsBytes), patch: pins, outputFiles,
    license: 'Upstream source retains its original license; see LICENSE and THIRD_PARTY_NOTICES.md.' };
  const bytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(join(root, 'provenance.json'), bytes);
  await writeFile(join(build, 'ifclite-sdk-provenance.json'), bytes);
  return join(root, 'provenance.json');
}

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
  await writeFile(join(engine, 'ifc-lite.js'), "import './snippets/fixture/js/retained-driver.mjs'; export const wasm = new URL('ifc-lite_bg.wasm', import.meta.url).href;\n");
  await writeFile(join(engine, 'ifc-lite_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await cp(resolve('scripts/fixtures/retained-notices'), emscripten, { recursive: true });
  await mkdir(join(emscripten, 'cmake/Modules/Platform'), { recursive: true });
  await writeFile(join(emscripten, 'cmake/Modules/Platform/Emscripten.cmake'), 'fixture toolchain');
  await writeFile(join(build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${adapter}\nSMLIB_SOURCE:UNINITIALIZED=${sdk}\nCMAKE_TOOLCHAIN_FILE:FILEPATH=${emscripten}/cmake/Modules/Platform/Emscripten.cmake\n`);
  const provenance = await sdkSnapshot(adapter, sdk, build, revision);
  await writeFile(join(build, 'CMakeCache.txt'), (await readFile(join(build, 'CMakeCache.txt'), 'utf8')) + `IFCLITE_SDK_PROVENANCE:INTERNAL=${provenance}\n`);
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
  assert.equal(manifest.assets.length, 23);
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

test('R1 real web loader import namespace is not a delivered bg.js (#7955)', async t => {
  const o = await fixture(t);
  await writeFile(join(o.engine, 'ifc-lite.js'), await readFile('scripts/fixtures/retained-loaders/wasm-bindgen.mjs'));
  await writeFile(join(o.build, 'ifclite_smlib_browser.mjs'), await readFile('scripts/fixtures/retained-loaders/emscripten.txt'));
  const inputs = join(o.out, '../real-shape.json');
  await stageRetainedBrowserAssets({ ...o, record: inputs, inputs: undefined, out: undefined });
  const manifest = await stageRetainedBrowserAssets({ ...o, inputs });
  await verifyRetainedAssets(o.out, inputs);
  assert.ok(manifest.dependencies.some(edge => edge.to === 'pkg-retained/ifc-lite_bg.wasm'));
  assert.ok(manifest.dependencies.some(edge => edge.to === 'ifclite_smlib_browser.wasm'));
  assert.ok(!manifest.assets.some(asset => asset.path.endsWith('_bg.js')));
});

for (const [id, source] of [
  ['R2 URL string', 'const url="https://example.test"; import(globalThis.asset);'],
  ['R2 comment', '/* import("./decoy.mjs") */ import(/* real */ globalThis.asset);'],
  ['R2 template expression', 'const text = `https://host/${import(globalThis.asset)}`;'],
  ['R2 regex', 'const re = /https:\\/\\/host/; import(globalThis.asset);'],
  ['R3 Worker URL', 'new Worker(new URL(globalThis.workerPath, import.meta.url), {type:"module"});'],
  ['R3 fetch', 'fetch(globalThis.wasmPath);'],
  ['R3 computed URL', 'new URL(globalThis.asset, import.meta.url);'],
]) test(`${id} refuses recording and publishes nothing (#7955)`, async t => {
  const o = await fixture(t);
  await writeFile(join(o.engine, 'extra.mjs'), source);
  const record = join(o.out, '../refused.json');
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record, inputs: undefined, out: undefined }));
  await assert.rejects(access(record), /ENOENT/);
  await assert.rejects(access(o.out), /ENOENT/);
});

// Independent review R2-F1/R2-F2: inspect real record and stage refusal paths,
// with all tempting sibling assets present so missing files cannot mask a bug.
for (const [label, source] of [
  ['object parameter', 'const path="./payload.wasm"; function load({path}) { return fetch(path); } load({path:"https://unlisted.invalid/runtime.wasm"});'],
  ['array parameter', 'const path="./payload.wasm"; function load([path]) { return fetch(path); }'],
  ['nested renamed parameter', 'const path="./payload.wasm"; function load({item:{url:path}}) { return fetch(path); }'],
  ['default/rest parameter', 'const path="./payload.wasm"; function load({url:path=globalThis.url}, ...rest) { return fetch(path); }'],
  ['object block binding', 'const path="./payload.wasm"; { const {path}=globalThis.config; fetch(path); }'],
  ['array block binding', 'const path="./payload.wasm"; { const [path]=globalThis.config; fetch(path); }'],
  ['destructured catch', 'const path="./payload.wasm"; try { throw globalThis.config; } catch ({path}) { fetch(path); }'],
  ['destructured loop', 'const path="./payload.wasm"; for (const {path} of globalThis.config) { fetch(path); }'],
  ['array loop', 'const path="./payload.wasm"; for (const [path] of globalThis.config) { fetch(path); }'],
  ['unused function const', 'function unused() { const path="./payload.wasm"; } fetch(path);'],
  ['sibling block const', '{ const path="./payload.wasm"; } { fetch(path); }'],
  ['loop visibility', 'for (const path="./payload.wasm"; false;) {} fetch(path);'],
  ['before declaration', 'fetch(path); const path="./payload.wasm";'],
  ['bare dynamic import', 'import("runtime.mjs");'],
  ['dot-prefixed bare dynamic import', 'import(".runtime.mjs");'],
  ['dot-prefixed bare static import', 'export * from ".runtime.mjs";'],
]) test(`R2-F1/F2 ${label} refuses record and stage with no output (#7955)`, async t => {
  const o = await fixture(t);
  await writeFile(join(o.engine, 'scope.mjs'), source);
  await writeFile(join(o.engine, 'payload.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  for (const name of ['runtime.mjs', '.runtime.mjs']) await writeFile(join(o.engine, name), 'export {};');
  const record = join(o.out, '../refused-scope.json');
  const refusal = /Unresolved asset locator|Bare .*import/;
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record, inputs: undefined, out: undefined }), refusal);
  await assert.rejects(stageRetainedBrowserAssets(o), refusal);
  await assert.rejects(access(record), /ENOENT/);
  await assert.rejects(access(o.out), /ENOENT/);
  assert.equal((await readdir(join(o.out, '..'))).filter(name => name.startsWith('.smlib-stage-')).length, 0);
});

test('R2-F1/F2 visible literal chains and explicit relative imports record and stage (#7955)', async t => {
  const o = await fixture(t);
  await writeFile(join(o.engine, 'scope.mjs'), `
    const path = './payload.wasm';
    const alias = path;
    function load() { const url = new URL(alias, import.meta.url).href; return fetch(url); }
    { const local = './runtime.mjs'; new Worker(new URL(local, import.meta.url)); }
    import('./runtime.mjs');
    export * from './runtime.mjs';
  `);
  await writeFile(join(o.engine, 'payload.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(join(o.engine, 'runtime.mjs'), 'export {};');
  const inputs = join(o.out, '../scoped-inputs.json');
  await stageRetainedBrowserAssets({ ...o, record: inputs, inputs: undefined, out: undefined });
  const manifest = await stageRetainedBrowserAssets({ ...o, inputs });
  assert.deepEqual(manifest.dependencies.filter(edge => edge.from === 'pkg-retained/scope.mjs').map(edge => edge.to),
    ['pkg-retained/payload.wasm', 'pkg-retained/runtime.mjs']);
  await verifyRetainedAssets(o.out, inputs);
});

// Parent review R3-F1/F2: both module-relative and context-relative candidates
// exist. Wrong-base acceptance cannot hide behind a missing asset.
for (const [label, source] of [
  ['href mutation', "const url=new URL('./payload.wasm',import.meta.url); url.href='https://unlisted.invalid/runtime.wasm'; fetch(url);"],
  ['computed property mutation', "const url=new URL('./payload.wasm',import.meta.url); url['pathname']=globalThis.path; fetch(url);"],
  ['URL object alias', "const url=new URL('./payload.wasm',import.meta.url); const alias=url; alias.host='unlisted.invalid'; fetch(url);"],
  ['URL object escape', "const url=new URL('./payload.wasm',import.meta.url); mutate(url); fetch(url);"],
  ['URL object method mutation', "const url=new URL('./payload.wasm',import.meta.url); url.searchParams.set('file',globalThis.path); fetch(url);"],
  ['unproved stored URL', "const url=new URL('./payload.wasm',import.meta.url); fetch(url);"],
  ['relative fetch', "fetch('./payload.wasm');"],
  ['relative const fetch', "const path='./payload.wasm'; const copy=path; fetch(copy);"],
  ['relative Worker', "new Worker('./runtime.mjs',{type:'module'});"],
  ['relative SharedWorker', "new SharedWorker('./runtime.mjs');"],
  ['relative importScripts', "importScripts('./runtime.mjs');"],
]) test(`R3-F1/F2 ${label} refuses record and stage without output (#7955)`, async t => {
  const o = await fixture(t);
  await mkdir(join(o.engine, 'nested'));
  await writeFile(join(o.engine, 'nested/entry.mjs'), source);
  for (const dir of [o.engine, join(o.engine, 'nested')]) {
    await writeFile(join(dir, 'payload.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
    await writeFile(join(dir, 'runtime.mjs'), 'export {};');
  }
  const record = join(o.out, '../refused-url.json');
  const refusal = /URL object|execution.context.relative|Unresolved asset locator/;
  await assert.rejects(stageRetainedBrowserAssets({ ...o, record, inputs: undefined, out: undefined }), refusal);
  await assert.rejects(stageRetainedBrowserAssets(o), refusal);
  await assert.rejects(access(record), /ENOENT/);
  await assert.rejects(access(o.out), /ENOENT/);
  assert.equal((await readdir(join(o.out, '..'))).filter(name => name.startsWith('.smlib-stage-')).length, 0);
});

test('R3-F1/F2 fresh module URLs, primitive href chains and /smlib roots actually stage (#7955)', async t => {
  const o = await fixture(t);
  await mkdir(join(o.engine, 'nested'));
  await writeFile(join(o.engine, 'nested/entry.mjs'), `
    const path = './payload.wasm';
    const href = new URL(path, import.meta.url).href;
    const copy = href;
    fetch(copy);
    fetch(new URL(path, import.meta.url));
    new Worker(new URL('./runtime.mjs', import.meta.url), {type:'module'});
    new SharedWorker(new URL('./runtime.mjs', import.meta.url));
    importScripts(new URL('./runtime.mjs', import.meta.url).href);
    fetch('/smlib/pkg-retained/nested/payload.wasm');
    new Worker('/smlib/worker.mjs', {type:'module'});
    import('./runtime.mjs');
  `);
  await writeFile(join(o.engine, 'nested/payload.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(join(o.engine, 'nested/runtime.mjs'), 'export {};');
  const inputs = join(o.out, '../explicit-url-inputs.json');
  await stageRetainedBrowserAssets({ ...o, record: inputs, inputs: undefined, out: undefined });
  const manifest = await stageRetainedBrowserAssets({ ...o, inputs });
  assert.deepEqual([...new Set(manifest.dependencies.filter(edge => edge.from === 'pkg-retained/nested/entry.mjs').map(edge => edge.to))].sort(),
    ['pkg-retained/nested/payload.wasm', 'pkg-retained/nested/runtime.mjs', 'worker.mjs']);
  await verifyRetainedAssets(o.out, inputs);
});

// #7955 R4: observe staged evidence and refusal, without executing a compiler.
test('staged SDK identity includes verified patched source and patch bytes', async t => {
  const o = await fixture(t);
  const m = await stageRetainedBrowserAssets(o);
  assert.equal(m.sdk.patch.id, 'imprint-status-v1');
  const receipt = await readFile(join(o.build, 'ifclite-sdk-provenance.json'));
  assert.deepEqual(await readFile(join(o.out, 'provenance/sdk.json')), receipt);
  assert.equal(m.sdk.patch.receiptSha256, hash(receipt));
  assert.deepEqual(await readFile(join(o.out, 'provenance/imprint-status-v1.patch')),
    await readFile(join(o.repoRoot, 'native/smlib-adapter/patches/imprint-status-v1.patch')));
  await verifyRetainedAssets(o.out, o.inputs);
});

test('missing or altered SDK evidence refuses for the intended reason (#7955 R2-C2)', async t => {
  const cases = [
    ['missing configured receipt', /ENOENT/, o => rm(join(o.build, 'ifclite-sdk-provenance.json'))],
    ['altered configured receipt', /configured receipt bytes mismatch/, o => writeFile(join(o.build, 'ifclite-sdk-provenance.json'), '{}')],
    ['altered selected receipt', /configured receipt bytes mismatch/, o => writeFile(join(o.build, 'ifclite-sdk/imprint-status-v1/provenance.json'), '{}')],
    ['unpatched source', /prepared file source\/SMLib\/kernel.cpp mismatch/, o => writeFile(join(o.build, 'ifclite-sdk/imprint-status-v1/source/SMLib/kernel.cpp'), 'unpatched')],
    ['extra source', /prepared file inventory mismatch/, o => writeFile(join(o.build, 'ifclite-sdk/imprint-status-v1/extra.cpp'), 'injected')],
    ['altered patch', /patch bytes mismatch/, o => writeFile(join(o.repoRoot, 'native/smlib-adapter/patches/imprint-status-v1.patch'), 'wrong patch')],
    ['altered pins', /receipt patch mismatch/, async o => {
      const path = join(o.repoRoot, 'native/smlib-adapter/patches/imprint-status-v1.json');
      const pins = JSON.parse(await readFile(path)); pins.outputSha256 = '0'.repeat(64);
      await writeFile(path, JSON.stringify(pins));
    }],
    ['missing cache receipt', /Missing CMake cache field IFCLITE_SDK_PROVENANCE/, async o => {
      const path = join(o.build, 'CMakeCache.txt');
      await writeFile(path, (await readFile(path, 'utf8')).replace(/^IFCLITE_SDK_PROVENANCE:.*\n/m, ''));
    }],
  ];
  for (const [name, expected, mutate] of cases) await t.test(name, async t => {
    const o = await fixture(t); await mutate(o);
    const record = join(o.out, '../rejected.json');
    await assert.rejects(stageRetainedBrowserAssets({ ...o, record, inputs: undefined, out: undefined }), expected);
    await assert.rejects(access(record), /ENOENT/);
    await assert.rejects(access(o.out), /ENOENT/);
  });
});

test('matching altered SDK receipts still require trusted metadata (#7955 R2-C2)', async t => {
  for (const [field, value, expected] of [
    ['schema', 2, /receipt schema mismatch/],
    ['upstreamRevision', '0'.repeat(40), /receipt upstream mismatch/],
    ['upstreamInventorySha256', '0'.repeat(64), /receipt input inventory mismatch/],
    ['patch', {}, /receipt patch mismatch/],
    ['pinsSha256', '0'.repeat(64), /receipt pins mismatch/],
    ['preparerSha256', '0'.repeat(64), /preparer mismatch/],
    ['outputFiles', {}, /receipt output inventory mismatch/],
  ]) await t.test(field, async t => {
    const o = await fixture(t);
    const selected = join(o.build, 'ifclite-sdk/imprint-status-v1/provenance.json');
    const receipt = JSON.parse(await readFile(selected)); receipt[field] = value;
    const bytes = JSON.stringify(receipt);
    await writeFile(selected, bytes);
    await writeFile(join(o.build, 'ifclite-sdk-provenance.json'), bytes);
    const record = join(o.out, '../rejected.json');
    await assert.rejects(stageRetainedBrowserAssets({ ...o, record, inputs: undefined, out: undefined }), expected);
    await assert.rejects(access(record), /ENOENT/);
    await assert.rejects(access(o.out), /ENOENT/);
  });
});

test('prepared SDK cannot escape through a symlink and published SDK identity cannot change', async t => {
  const o = await fixture(t);
  const kernel = join(o.build, 'ifclite-sdk/imprint-status-v1/source/SMLib/kernel.cpp');
  const bytes = await readFile(kernel); const external = join(o.out, '../external.cpp');
  await writeFile(external, bytes); await rm(kernel); await symlink(external, kernel);
  await assert.rejects(stageRetainedBrowserAssets(o), /Nonregular|Escaped/);
  await rm(kernel); await writeFile(kernel, bytes);
  await stageRetainedBrowserAssets(o);
  const path = join(o.out, 'asset-manifest.json'); const m = JSON.parse(await readFile(path));
  m.sdk.patch.outputInventorySha256 = '0'.repeat(64);
  await writeFile(path, JSON.stringify(m));
  await assert.rejects(verifyRetainedAssets(o.out, o.inputs), /manifest/);
});
