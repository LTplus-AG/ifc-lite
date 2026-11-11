/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `needs_cargo=false` is what lets test.yml's rust-semver job skip the
 * toolchain and the full gate, so only a final exit-0 verdict may write it.
 * Separate from check-rust-semver-registry.test.mjs because these tests read
 * files, which check-source-text-assertions would pair with that file's
 * output assertions.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPTS, 'check-rust-semver-registry.mjs');
const STEP_RUN = parse(readFileSync(join(SCRIPTS, '..', '.github', 'workflows', 'test.yml'), 'utf8'))
  .jobs['rust-semver'].steps.find((s) => s.id === 'registry')?.run;

function withOutputFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'semver-registry-'));
  try {
    const out = join(dir, 'github-output');
    writeFileSync(out, '');
    return fn(dir, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real CLI writes needs_cargo=false exactly when it exits 0', () => {
  withOutputFile((dir, out) => {
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
    assert.equal(readFileSync(out, 'utf8'), res.status === 0 ? 'needs_cargo=false\n' : '', `exit ${res.status}`);
  });
});

test('importing the script without running its main writes nothing', () => {
  withOutputFile((dir, out) => {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)})`], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(out, 'utf8'), '');
  });
});

/** The shipped step, with `node` stubbed to write (or not) and exit. */
function runStep({ status, writesFalse }) {
  assert.ok(STEP_RUN, 'test.yml rust-semver has no step with id `registry`');
  return withOutputFile((dir, out) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const write = writesFalse ? `echo needs_cargo=false >> "$GITHUB_OUTPUT"\n` : '';
    writeFileSync(join(bin, 'node'), `#!/bin/sh\n${write}exit ${status}\n`);
    chmodSync(join(bin, 'node'), 0o755);
    const res = spawnSync('bash', ['-e', '-c', STEP_RUN], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, GITHUB_OUTPUT: out },
    });
    return { exit: res.status, output: readFileSync(out, 'utf8') };
  });
}

for (const [name, run, expected] of [
  ['a final verdict skips cargo', { status: 0, writesFalse: true }, { exit: 0, output: 'needs_cargo=false\n' }],
  ['exit 0 that never wrote the output leaves it unset, so the full gate runs', { status: 0, writesFalse: false }, { exit: 0, output: '' }],
  ['exit 3 passes the step and leaves the output unset', { status: 3, writesFalse: false }, { exit: 0, output: '' }],
  ['exit 1 fails the job', { status: 1, writesFalse: false }, { exit: 1, output: '' }],
  ['exit 2 fails the job', { status: 2, writesFalse: false }, { exit: 2, output: '' }],
  ['any other exit fails the job', { status: 137, writesFalse: false }, { exit: 137, output: '' }],
]) {
  test(`registry step: ${name}`, () => assert.deepEqual(runStep(run), expected));
}
