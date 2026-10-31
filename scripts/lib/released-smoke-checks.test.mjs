/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundaryViolations, cargoLockProblems, crateManifestProblems, isInside, noticeProblems, npmLockProblems,
  stripArchiveRoot, summarize,
} from './released-smoke-checks.mjs';

test('archive roots are stripped', () => {
  assert.equal(stripArchiveRoot('package/pkg/a.js'), 'pkg/a.js');
  assert.equal(stripArchiveRoot('ifc-lite-geometry-runtime-27.1.0/src/lib.rs'), 'src/lib.rs');
});

test('wasm package: allowed wasm passes, retained engine, SDK and native binaries fail', () => {
  const ok = ['pkg/ifc-lite_bg.wasm', 'pkg-diff/ifc-lite-diff_bg.wasm', 'retained.js', 'pkg-retained/ifc-lite.d.ts', 'THIRD_PARTY_NOTICES.txt'];
  assert.deepEqual(boundaryViolations(ok, 'npm-wasm'), []);
  const bad = boundaryViolations(['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'smlib/worker.mjs', 'bin/worker.node', 'extra.wasm'], 'npm-wasm');
  assert.equal(bad.length, 5);
});

test('cli package: its own smlib-hooks loader is not an SDK, an SDK wasm is', () => {
  assert.deepEqual(boundaryViolations(['dist/retained/smlib-hooks.js', 'dist/index.js'], 'npm-cli'), []);
  assert.equal(boundaryViolations(['dist/ifclite_smlib_browser.wasm'], 'npm-cli').length, 1);
  assert.equal(boundaryViolations(['smlib/node/worker.mjs'], 'npm-cli').length, 1);
});

test('crate archive is source only', () => {
  assert.deepEqual(boundaryViolations(['src/lib.rs', 'Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock', 'README.md', 'LICENSE', '.cargo_vcs_info.json'], 'crate'), []);
  assert.equal(boundaryViolations(['build.rs', 'src/lib.rs'], 'crate').length, 1);
  assert.equal(boundaryViolations(['native/worker', 'vendor.wasm'], 'crate').length, 3);
});

test('notices: missing file and OPEN: lines fail', () => {
  assert.deepEqual(noticeProblems('all resolved\nelection: wasm_sync'), []);
  assert.match(noticeProblems(undefined)[0], /missing/);
  assert.match(noticeProblems('ok\n  OPEN: chrono election\n')[0], /1 OPEN: line/);
});

test('crate manifest needs a registry version and feature forwarding', () => {
  const good = '[features]\nretained-runtime = ["ifc-lite-geometry/retained-runtime"]\n[dependencies.ifc-lite-geometry]\nversion = "27.1.0"\n';
  assert.deepEqual(crateManifestProblems(good), []);
  assert.equal(crateManifestProblems(good.replace('version = "27.1.0"', 'path = "../geometry"')).length, 2);
  assert.equal(crateManifestProblems(good.replace('retained-runtime"]', 'other"]')).length, 1);
});

test('lock files must come from public registries', () => {
  assert.deepEqual(npmLockProblems({ packages: { '': {}, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' } } }), []);
  assert.equal(npmLockProblems({ packages: { 'node_modules/a': { resolved: 'file:../a' }, 'node_modules/b': { link: true } } }).length, 2);
  const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
  const lock = `[[package]]\nname = "smoke_consumer"\n\n[[package]]\nname = "x"\n${registry}\n\n[[package]]\nname = "y"\n`;
  assert.deepEqual(cargoLockProblems(lock, 'smoke_consumer'), ['y: path (no source)']);
});

test('summary: failures dominate, skips are explicit, never silently pass', () => {
  assert.equal(summarize([{ status: 'pass' }]).status, 'pass');
  assert.equal(summarize([{ status: 'pass' }, { status: 'skip' }]).status, 'pass-with-skips');
  const failed = summarize([{ status: 'skip' }, { status: 'fail' }]);
  assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.counts, { pass: 0, fail: 1, skip: 1 });
});

test('isInside distinguishes repo from scratch', () => {
  assert.equal(isInside(process.cwd(), process.cwd()), true);
  assert.equal(isInside(process.cwd(), '/tmp'), false);
});
