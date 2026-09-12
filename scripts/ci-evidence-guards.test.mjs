/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRunnableCargoTests, parseArgs } from './ci-assert-runnable-cargo-tests.mjs';
import { EXPECTED_WHEEL_ARTIFACTS, prepareWheelMatrix } from './ci-prepare-wheel-matrix.mjs';
import { runSdkCanaries } from './ci-run-sdk-canaries.mjs';

function temporaryRoot(context, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('SDK canary guard fails on absent, empty, and red bundle sets', (context) => {
  const root = temporaryRoot(context, 'sdk-canary-guard-');
  assert.throws(() => runSdkCanaries(root, () => 0), /unreadable/);
  const canaries = join(root, 'tests', 'extensions', 'canaries');
  mkdirSync(canaries, { recursive: true });
  assert.throws(() => runSdkCanaries(root, () => 0), /no bundle directories/);
  for (const name of ['green', 'red']) mkdirSync(join(canaries, name));
  const observed = [];
  assert.throws(() => runSdkCanaries(root, (directory) => {
    observed.push(directory);
    return directory.endsWith('red') ? 2 : 0;
  }), /1 SDK canary bundle/);
  assert.equal(observed.length, 2);
  assert.equal(runSdkCanaries(root, () => 0), 2);
});

test('Cargo list guard proves at least one non-ignored test per target', () => {
  const calls = [];
  const options = { package: 'crate', features: 'feature', tests: ['alpha', 'beta'] };
  assertRunnableCargoTests(options, (args) => {
    calls.push(args);
    return args.includes('--ignored') ? 'ignored_case: test\n' : 'live_case: test\nignored_case: test\n';
  });
  assert.equal(calls.length, 4);
  assert.throws(() => assertRunnableCargoTests({ ...options, tests: ['empty'] }, () => ''), /zero runnable tests/);
  assert.throws(() => assertRunnableCargoTests({ ...options, tests: ['ignored'] }, (args) => args.includes('--ignored') ? 'only: test\n' : 'only: test\n'), /zero runnable tests/);
  assert.deepEqual(parseArgs(['--package', 'crate', '--test', 'one', '--test', 'two']), { package: 'crate', features: '', tests: ['one', 'two'] });
  assert.throws(() => parseArgs(['--unknown', 'x']), /unknown or incomplete/);
});

test('wheel guard requires the exact matrix and one wheel per artifact', (context) => {
  const root = temporaryRoot(context, 'wheel-matrix-guard-');
  const dist = join(root, 'dist');
  mkdirSync(dist);
  assert.throws(() => prepareWheelMatrix(root), /directories differ/);
  for (const [index, artifact] of EXPECTED_WHEEL_ARTIFACTS.entries()) {
    const directory = join(dist, artifact);
    mkdirSync(directory);
    writeFileSync(join(directory, `wheel-${index}.whl`), 'wheel');
  }
  prepareWheelMatrix(root);
  assert.equal(readdirSync(join(dist, 'publish')).length, EXPECTED_WHEEL_ARTIFACTS.length);
  const first = join(dist, EXPECTED_WHEEL_ARTIFACTS[0]);
  writeFileSync(join(first, 'duplicate.whl'), 'wheel');
  assert.throws(() => prepareWheelMatrix(root), /exactly one wheel/);
  assert.equal(existsSync(join(dist, 'publish', 'wheel-0.whl')), true);
});
