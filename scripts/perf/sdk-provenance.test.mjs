/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceSnapshot, verifySource } from './sdk-prepare.mjs';
import { installedClosure } from './sdk-tools.mjs';
import { buildOutcomes } from './sdk-build-contract.mjs';
import { bindgenVersion } from './sdk-bindgen.mjs';
import { requireBuildCompletion, requireCohortCompletion } from './sdk-completion.mjs';
import { canonicalSemanticWarning, canonicalConsumerSummary } from './sdk-semantic-warnings.mjs';
const temporary = fn => async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-provenance-'));
  try { await fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};
test('#6537 sourceSnapshot covers a real committed Git tree larger than Node default output buffer', { timeout: 90000 }, temporary(async directory => {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet'); git('config', 'user.name', 'SDK invariant'); git('config', 'user.email', 'sdk-invariant@example.invalid');
  const count = 6000, names = [];
  for (let index = 0; index < count; index++) {
    const name = `entity-${String(index).padStart(4, '0')}-${'x'.repeat(160)}.txt`;
    names.push(name); writeFileSync(join(directory, name), `entity ${index}\n`);
  }
  git('add', '--', '.'); git('commit', '--quiet', '-m', 'large tree invariant fixture');
  assert.ok(Buffer.byteLength(git('ls-tree', '-r', '-z', 'HEAD')) > 1024 ** 2);
  const snapshot = await sourceSnapshot(directory, git('rev-parse', 'HEAD'));
  assert.equal(Object.keys(snapshot.files).length, count);
  for (const index of [0, 2999, 5999]) {
    assert.equal(snapshot.files[join(directory, names[index])], createHash('sha256').update(`entity ${index}\n`).digest('hex'));
  }
  writeFileSync(join(directory, names[5999]), 'changed last file beyond the former buffer boundary');
  await assert.rejects(verifySource(snapshot), /source/);
}));
test('#6537 actual Git snapshot refuses tracked changes and retargeted byte-identical source links', temporary(async directory => {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'SDK invariant'); git('config', 'user.email', 'sdk-invariant@example.invalid');
  writeFileSync(join(directory, 'a'), 'immutable source'); writeFileSync(join(directory, 'b'), 'immutable source');
  symlinkSync('a', join(directory, 'link')); git('add', '.'); git('commit', '-m', 'invariant fixture');
  const snapshot = await sourceSnapshot(directory, git('rev-parse', 'HEAD')); await verifySource(snapshot);
  writeFileSync(join(directory, 'a'), 'changed source'); await assert.rejects(verifySource(snapshot), /source/);
  writeFileSync(join(directory, 'a'), 'immutable source');
  unlinkSync(join(directory, 'link')); symlinkSync('b', join(directory, 'link'));
  await assert.rejects(verifySource(snapshot), /source/);
}));
test('#6537 installed closure follows real transitive resolution and hashes consumed package bytes', temporary(async directory => {
  writeFileSync(join(directory, 'package.json'), '{"name":"invariant-root"}');
  for (const [name, dependencies] of [['entry', { leaf: '1.0.0' }], ['leaf', {}]]) {
    const path = join(directory, 'node_modules', name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
    writeFileSync(join(path, 'index.js'), `export const name = '${name}';`);
  }
  const seeds = [{ name: 'entry', from: join(directory, 'package.json') }], before = await installedClosure(seeds);
  assert.equal(before.packageCount, 2); assert.equal(Object.keys(before.files).length, 4);
  writeFileSync(join(directory, 'node_modules/leaf/index.js'), 'export const changed = true;');
  const after = await installedClosure(seeds);
  assert.notEqual(before.normalized['leaf@1.0.0/index.js'], after.normalized['leaf@1.0.0/index.js']);
  assert.equal(before.normalized['entry@1.0.0/index.js'], after.normalized['entry@1.0.0/index.js']);
  await assert.rejects(installedClosure([{ name: 'absent', from: join(directory, 'package.json') }]), /absent/);
}));
test('#6537 installed package identity includes shipped nested runtime dependency bytes', temporary(async directory => {
  writeFileSync(join(directory, 'package.json'), '{"name":"invariant-root"}');
  const bundled = join(directory, 'node_modules/entry/dist/node_modules/runtime');
  mkdirSync(bundled, { recursive: true });
  writeFileSync(join(directory, 'node_modules/entry/package.json'), '{"name":"entry","version":"1.0.0"}');
  const runtime = join(bundled, 'index.js'); writeFileSync(runtime, 'export const value = 1;');
  const seeds = [{ name: 'entry', from: join(directory, 'package.json') }];
  const before = await installedClosure(seeds); assert.ok(before.files[runtime]);
  writeFileSync(runtime, 'export const value = 2;');
  const after = await installedClosure(seeds); assert.notEqual(before.files[runtime], after.files[runtime]);
}));
test('#6537 source-build producing receipt requires every fresh task plus successful WASM emission', () => {
  const names = ['geometry', 'data', 'encoding', 'wasm-lifecycle', 'wasm'];
  const log = names.map(name => `@ifc-lite/${name}:build: cache bypass, force executing abcd`).join('\n')
    + '\n@ifc-lite/wasm:build: ✨ Build complete!\nTasks: 5 successful, 5 total\nCached: 0 cached, 5 total\n';
  assert.equal(buildOutcomes(log).total, 5);
  assert.equal(buildOutcomes(log.replaceAll('cache bypass, force executing', 'cache miss, executing')).cached, 0);
  for (const broken of [log.replace('5 successful', '4 successful'), log.replace('0 cached', '1 cached'),
    log.replace('✨ Build complete!', 'using stale runtime'), log.replace('@ifc-lite/wasm:build: cache', '@other/wasm:build: cache')]) {
    assert.throws(() => buildOutcomes(broken), /outcomes/);
  }
});
test('#6537 known semantic omissions retain classification while unknown recovery and malformed counts refuse', () => {
  const warning = '[ifc-lite layers] batch: sliced 3, 1 NOT sliced — #2260673=skip:empty-base-mesh';
  assert.equal(canonicalSemanticWarning(warning).kind, 'layer-slicing');
  assert.equal(canonicalSemanticWarning(warning.replace('1 NOT', '2 NOT')), null);
  assert.equal(canonicalSemanticWarning(warning.replace('skip:empty-base-mesh', 'skip:worker-retry')), null);
  assert.equal(canonicalSemanticWarning('[ifc-lite] worker restarted after panic'), null);
  const summary = '[ifc-lite] 44 CSG failure(s) across 30 product(s) this load - see diagnostics.failuresByReason; not every reason leaves an opening/void uncut';
  assert.equal(canonicalConsumerSummary(summary).total, 44);
  assert.equal(canonicalConsumerSummary(summary.replace('44 CSG', '-1 CSG')), null);
});

test('#6537 transform version comes from one exact locked package, not a prefix or unrelated dependency', () => {
  const lock = '[[package]]\nname = "wasm-bindgen-futures"\nversion = "0.4.76"\n\n[[package]]\nname = "wasm-bindgen"\nversion = "0.2.126"\n';
  assert.equal(bindgenVersion(lock), '0.2.126');
  assert.throws(() => bindgenVersion(lock + lock), /one exact/);
  assert.throws(() => bindgenVersion(lock.replace('0.2.126', 'latest')), /one exact/);
});

test('#6537 late refusal fences outrank already successful build and cohort cleanup receipts', () => {
  const build = { exit: 0, cleanup: { status: 'complete' }, logFlush: { status: 'complete' } };
  requireBuildCompletion(build);
  assert.throws(() => requireBuildCompletion(build, 'received SIGTERM during final source verification'), /SIGTERM/);
  build.pipeTailCertified = false; assert.throws(() => requireBuildCompletion(build), /log/);
  const cohort = { ownedCleanup: { status: 'complete' }, serverCleanup: [{ status: 'complete' }],
    samples: Array.from({ length: 56 }, () => ({ status: 'complete' })), pairs: Array.from({ length: 28 }, () => ({ status: 'complete' })), finalInputVerification: 'complete' };
  requireCohortCompletion(cohort);
  assert.throws(() => requireCohortCompletion(cohort, 'received SIGINT during server close'), /SIGINT/);
  cohort.samples[55].status = 'refused'; assert.throws(() => requireCohortCompletion(cohort), /cohort/);
  cohort.samples[55].status = 'complete'; cohort.serverCleanup[0].status = 'refused';
  assert.throws(() => requireCohortCompletion(cohort), /cleanup/);
});
