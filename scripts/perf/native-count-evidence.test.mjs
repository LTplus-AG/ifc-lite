/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6993 native count driver, reached by test.yml's scripts/perf/*.test.mjs
// catch-all: the TS verdict tests under tsx, and the CLI refusals that must
// happen before any host, fixture or browser work. Never launches Chrome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const QUERY = '?perfTrace=1&geomWorkers=4&meshCache=0&perf.benchmarkUploads=1&perf.batchSizing=%7B%22targetMs%22%3A8000%2C%22minJobs%22%3A64%2C%22maxJobs%22%3A64%7D';
const driver = (...args) => spawnSync(TSX, ['scripts/perf/native-count-driver.mts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('#6993 native count verdict, query and receipt logic', (context) => {
  // A nested `node --test` must create its own runner (see frame-gpu-night-history.test.mjs).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(TSX, ['--test', 'scripts/perf/native-count-evidence.test.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`);
  context.diagnostic(run.stdout.trim().split('\n').filter((line) => /^(# |ℹ )(tests|pass|fail) /.test(line)).join(' '));
});

test('#6993 --plan prints four fresh file-input loads at the literal query, launching nothing', () => {
  const run = driver('--plan');
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.query, QUERY);
  assert.deepEqual(plan.samples.map((s) => [s.fixture, s.iteration]), [['FZK', 1], ['FZK', 2], ['Snowdon', 1], ['Snowdon', 2]]);
  for (const sample of plan.samples) {
    assert.equal(sample.url, `http://127.0.0.1:<port>/${QUERY}`);
    assert.equal(sample.route, 'input[type=file] -> useIfcLoader.loadFile');
  }
});

test('#6993 the driver refuses unknown flags and unpinned sources before any host or browser work', () => {
  const unknown = driver('--plan', '--pairs', '3');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument --pairs/);
  const out = mkdtempSync(join(tmpdir(), 'native-count-cli-'));
  try {
    const unpinned = driver('--out-dir', join(out, 'run'));
    assert.notEqual(unpinned.status, 0);
    assert.match(unpinned.stderr, /source revision is required/);
    assert.equal(existsSync(join(out, 'run')), false, 'an unpinned run must not leave a receipt');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
