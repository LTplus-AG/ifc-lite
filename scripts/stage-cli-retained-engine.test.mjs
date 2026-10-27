// SPDX-License-Identifier: MPL-2.0
// #7955 packaging invariants: fixtures are inert, never numerical evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageCliRetainedEngine } from './stage-cli-retained-engine.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cli-retained-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk'), build = join(root, 'build'), repoRoot = join(root, 'repo'), pkgRetained = join(root, 'pkg');
  const adapter = join(repoRoot, 'native/smlib-adapter');
  for (const path of [build, pkgRetained, join(adapter, 'browser'), join(adapter, 'node'), join(sdk, 'source/SMLib'), join(sdk, 'source/SM_API')]) {
    await mkdir(path, { recursive: true });
  }
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'source/SMLib/kernel.cpp', 'source/SM_API/api.cpp']) {
    await writeFile(join(sdk, path), `SDK packaging fixture ${path}\n`);
  }
  const git = (...args) => execFileSync('git', ['-C', sdk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Packaging fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Packaging fixture');
  await writeFile(join(adapter, 'CMakeLists.txt'), `set(IFCLITE_SMLIB_REVISION ${git('rev-parse', 'HEAD')})\n`);
  for (const name of ['client', 'worker', 'module', 'contract', 'sweep', 'sweep-contract']) {
    const source = resolve(`native/smlib-adapter/browser/${name}.mjs`);
    await copyFile(source, join(adapter, `browser/${name}.mjs`));
    await copyFile(source, join(build, `${name}.mjs`));
  }
  for (const name of ['client', 'worker', 'hooks']) {
    await copyFile(resolve(`native/smlib-adapter/node/${name}.mjs`), join(adapter, `node/${name}.mjs`));
  }
  await copyFile(resolve('LICENSE'), join(repoRoot, 'LICENSE'));
  await writeFile(join(build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${adapter}\nSMLIB_SOURCE:PATH=${sdk}\n`);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await writeFile(join(build, 'ifclite_smlib_browser.wasm'), wasm);
  await copyFile(resolve('scripts/lib/__fixtures__/smlib-node/module.mjs'), join(build, 'ifclite_smlib_browser.mjs'));
  await writeFile(join(pkgRetained, 'ifc-lite_bg.wasm'), wasm);
  // Staging must not evaluate even an invalid supplied module.
  await writeFile(join(pkgRetained, 'ifc-lite.js'), 'export const fixture = true;\nthrow new Error("packaging must not execute me");\n');
  await writeFile(join(pkgRetained, 'ifc-lite.d.ts'), 'export {};\n');
  await writeFile(join(pkgRetained, 'package.json'), '{"name":"wasm-pack-web-fixture"}\n');
  const notice = join(root, 'toolchain-LICENSE');
  await writeFile(notice, 'Supplied toolchain runtime notice fixture\n');
  return { build, sdk, repoRoot, pkgRetained, out: join(root, 'engine with spaces'), toolchainNotices: [{ name: 'runtime-LICENSE', path: notice }] };
}

test('self-contained engine has exact licenses, complete asset hashes and a toolchain inventory (#7955)', async t => {
  const options = await fixture(t);
  const { manifest, manifestSha256 } = await stageCliRetainedEngine(options);
  assert.equal(manifest.format, 'ifc-lite.retained-engine/1');
  assert.equal(manifest.qualified, false);
  assert.equal(manifest.buildAttestation, false);
  assert.equal(manifest.capabilities, null, 'packaging never observes a kernel');
  const serialized = await readFile(join(options.out, 'engine-manifest.json'));
  assert.deepEqual(JSON.parse(serialized), manifest);
  assert.equal(sha256(serialized), manifestSha256);
  assert.equal(JSON.parse(await readFile(join(options.out, 'pkg-retained/package.json'), 'utf8')).type, 'module');
  assert.equal(JSON.parse(await readFile(join(options.pkgRetained, 'package.json'), 'utf8')).type, undefined, 'input build stays untouched');
  const seen = [];
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${file}/`);
      else seen.push(file);
    }
  }
  await walk(options.out);
  assert.deepEqual(manifest.assets.map(asset => asset.path).sort(), seen.filter(path => path !== 'engine-manifest.json').sort());
  for (const asset of manifest.assets) {
    const bytes = await readFile(join(options.out, asset.path));
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(sha256(bytes), asset.sha256, asset.path);
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.deepEqual(await readFile(join(options.out, 'LICENSES/SMLib', name)), await readFile(join(options.sdk, name)));
  }
  assert.deepEqual(await readFile(join(options.out, 'LICENSES/ifc-lite/LICENSE')), await readFile(join(options.repoRoot, 'LICENSE')));
  const [notice] = manifest.toolchainNotices;
  assert.equal(notice.name, 'runtime-LICENSE');
  assert.equal(sha256(await readFile(join(options.out, notice.path))), notice.sha256);
  await assert.rejects(stageCliRetainedEngine(options), /already exists/);

  // Remove every input: hooks + worker + shared browser modules must resolve
  // entirely inside the published engine, including a path containing spaces.
  for (const path of [options.build, options.sdk, options.repoRoot, options.pkgRetained]) await rm(path, { recursive: true });
  const engine = pathToFileURL(`${options.out}/`).href;
  const childPath = join(dirname(options.out), 'isolated-engine.mjs');
  await writeFile(childPath, `
    import { register } from 'node:module';
    import assert from 'node:assert/strict';
    const engine = new URL(process.argv[2]);
    await assert.rejects(import(new URL('pkg-retained/ifc-lite.js', engine)), /packaging must not execute me/);
    register(new URL('smlib/node/hooks.mjs', engine), { data: { smlib: new URL('smlib/', engine).href } });
    const { SmlibWorkerTransport } = await import('/smlib/client.mjs');
    const { request } = await import('/smlib/contract.mjs');
    assert.equal(typeof (await import('/smlib/sweep.mjs')).uploadSweep, 'function');
    assert.equal(typeof (await import('/smlib/sweep-contract.mjs')).runSweepContract, 'function');
    assert.equal((await import('data:text/javascript,export default 42')).default, 42);
    const transport = new SmlibWorkerTransport({ workerUrl: '/smlib/worker.mjs', timeout: 3000 });
    try {
      const input = request(0), expected = input.slice(0);
      assert.deepEqual(await transport.batch([input], transport.incarnation), [expected]);
      assert.equal(input.byteLength, 0);
      assert.ok(transport.peakHeapBytes > 0);
    } finally { transport.dispose(); }
    console.log('isolated staged engine transport + resolve hook passed');
  `);
  const child = spawnSync(process.execPath, [childPath, engine], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /isolated staged engine transport \+ resolve hook passed/);
});

test('missing runtime, license, node module or stale browser module leaves no output (#7955)', async t => {
  for (const missing of ['wasm', 'sdk-license', 'node-client', 'pkg-js']) {
    const options = await fixture(t);
    const path = {
      wasm: join(options.build, 'ifclite_smlib_browser.wasm'),
      'sdk-license': join(options.sdk, 'THIRD_PARTY_NOTICES.md'),
      'node-client': join(options.repoRoot, 'native/smlib-adapter/node/client.mjs'),
      'pkg-js': join(options.pkgRetained, 'ifc-lite.js'),
    }[missing];
    await rm(path);
    await assert.rejects(stageCliRetainedEngine(options), /ENOENT|not clean/);
    await assert.rejects(access(options.out), /ENOENT/);
    assert.ok(!(await readdir(dirname(options.out))).some(name => name.startsWith('.cli-retained-stage-')));
  }
  const options = await fixture(t);
  await writeFile(join(options.build, 'client.mjs'), 'stale');
  await assert.rejects(stageCliRetainedEngine(options), /Stale configured module/);
  await assert.rejects(access(options.out), /ENOENT/);
});

test('rejects source overlap, malformed runtime, symlinks and unsafe notice names (#7955)', async t => {
  const options = await fixture(t);
  await assert.rejects(stageCliRetainedEngine({ ...options, out: join(options.pkgRetained, 'engine') }), /overlap/);
  await assert.rejects(stageCliRetainedEngine({ ...options, out: dirname(options.repoRoot) }), /overlap/);
  await assert.rejects(stageCliRetainedEngine({ ...options, toolchainNotices: [{ name: '../escape', path: options.toolchainNotices[0].path }] }), /notice name/);
  await assert.rejects(stageCliRetainedEngine({ ...options, toolchainNotices: [...options.toolchainNotices, ...options.toolchainNotices] }), /duplicate/);
  const wasm = join(options.pkgRetained, 'ifc-lite_bg.wasm');
  await writeFile(wasm, 'invalid wasm');
  await assert.rejects(stageCliRetainedEngine(options), /not a wasm/);
  await rm(wasm);
  await symlink(join(options.build, 'ifclite_smlib_browser.wasm'), wasm);
  await assert.rejects(stageCliRetainedEngine(options), /regular file/);
  await assert.rejects(access(options.out), /ENOENT/);
});
