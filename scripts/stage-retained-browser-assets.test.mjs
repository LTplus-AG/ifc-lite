// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  await writeFile(join(adapter, 'CMakeLists.txt'), `set(IFCLITE_SMLIB_REVISION ${revision})\n`);
  // Use actual canonical browser modules, not an imitation transport implementation.
  for (const name of ['client', 'worker', 'module', 'sweep', 'sweep-contract', 'contract', 'mesh-witness', 'region-recipes']) {
    const bytes = await readFile(resolve(`native/smlib-adapter/browser/${name}.mjs`));
    await writeFile(join(adapter, `browser/${name}.mjs`), bytes);
    await writeFile(join(build, `${name}.mjs`), bytes);
  }
  await writeFile(join(build, 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${adapter}\nSMLIB_SOURCE:UNINITIALIZED=${sdk}\n`);
  // Valid empty WASM module: packaging witness only, never a numerical SDK claim.
  await writeFile(join(build, 'ifclite_smlib_browser.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(join(build, 'ifclite_smlib_browser.mjs'), 'export default function packagingFixture() {}\n');
  return { build, sdk, repoRoot, out: join(root, 'published') };
}

test('stages exact bytes, licenses and checkable hashes without executing generated modules', async t => {
  const options = await fixture(t);
  const manifest = await stageRetainedBrowserAssets(options);
  assert.equal(manifest.qualified, false);
  assert.equal(manifest.buildAttestation, false);
  assert.equal(manifest.assets.length, 12);
  assert.equal((await readdir(options.out)).length, 13);
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
