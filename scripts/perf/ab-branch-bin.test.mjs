/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/ab.sh reads the branch probe from where cargo wrote it.
 *
 * Fleet benchmark workers export CARGO_TARGET_DIR, so `cargo build` puts the
 * branch probe there; ab.sh used to look under $ROOT/target regardless and
 * aborted with "a probe binary is missing" after both builds succeeded.
 * `--print-branch-bin` prints the path without building anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ab = join(root, 'scripts', 'perf', 'ab.sh');
const fixture = join(mkdtempSync(join(tmpdir(), 'ab-branch-bin-')), 'model.ifc');
writeFileSync(fixture, 'ISO-10303-21;\n');

function branchBin(env) {
  const res = spawnSync('bash', [ab, fixture, '--print-branch-bin'], { cwd: root, encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

test('ab.sh reads the branch probe from an inherited CARGO_TARGET_DIR', () => {
  const target = mkdtempSync(join(tmpdir(), 'ab-target-'));
  assert.equal(branchBin({ ...process.env, CARGO_TARGET_DIR: target }), join(target, 'profiling', 'examples', 'perf_probe'));
});

test('ab.sh falls back to the repository target directory', () => {
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  assert.equal(branchBin(env), join(root, 'target', 'profiling', 'examples', 'perf_probe'));
});
