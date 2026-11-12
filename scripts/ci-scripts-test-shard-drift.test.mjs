/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * test-red-on-main.yml's shard-drift step, run with `gh` stubbed: it warns
 * only when the slower scripts-tests shard exceeds the faster by MAX_RATIO,
 * never fails, and says so when it has nothing to compare or cannot read the
 * run. The pins in scripts/ci-scripts-test-shards.mjs are re-measured by hand,
 * so this warning is what tells anyone to do it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEP = parse(readFileSync(join(ROOT, '.github', 'workflows', 'test-red-on-main.yml'), 'utf8'))
  .jobs.report.steps.find((s) => s.name === 'Warn when the scripts-tests shards drift apart');

/**
 * Run the shipped step against `jobs` (an Actions jobs-API page). The stub
 * `gh` hands the step's own --jq expression to the real jq, so the filter is
 * tested too; `status` makes gh fail instead.
 */
function runStep(jobs, status = 0) {
  assert.ok(STEP, 'test-red-on-main.yml has no shard-drift step');
  const dir = mkdtempSync(join(tmpdir(), 'shard-drift-'));
  try {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs }));
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      `[ ${status} -eq 0 ] || exit ${status}`,
      'while [ "$#" -gt 0 ]; do if [ "$1" = --jq ]; then shift; exec jq -r "$1" ' + `'${join(dir, 'jobs.json')}'; fi; shift; done`,
      'exit 64',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
    const res = spawnSync('bash', ['-e', '-c', STEP.run], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH, REPO: 'o/r', RUN_ID: '1', RUN_URL: 'https://example/run/1', MAX_RATIO: STEP.env.MAX_RATIO },
    });
    return { status: res.status, warnings: res.stdout.split('\n').filter((l) => l.startsWith('::warning')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The API's form, which jq's fromdateiso8601 needs: no milliseconds.
const at = (s) => new Date(Date.UTC(2026, 10, 12, 0, 0, s)).toISOString().replace('.000Z', 'Z');
/** A shard job whose test step took `seconds`, after `setup` seconds of other steps. */
const job = (n, seconds, { conclusion = 'success', setup = 120 } = {}) => ({
  name: `Node scripts tests (shard ${n}/2)`,
  conclusion,
  started_at: at(0),
  completed_at: at(setup + seconds),
  steps: [
    { name: 'Verify fixtures', started_at: at(0), completed_at: at(setup) },
    { name: 'Run every scripts/ test file (glob catch-all)', started_at: at(setup), completed_at: at(setup + seconds) },
  ],
});

test('balanced shards: no warning', () => {
  assert.deepEqual(runStep([job(1, 370), job(2, 310)]), { status: 0, warnings: [] });
});

test('the count-based split #9780 measured (445 s / 178 s) warns, naming the slower shard', () => {
  const { status, warnings } = runStep([job(1, 178), job(2, 445)]);
  assert.equal(status, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('Node scripts tests (shard 2/2) took 445s'), warnings[0]);
});

test('exactly at the limit does not warn; just over it does', () => {
  assert.deepEqual(runStep([job(1, 200), job(2, 300)]).warnings, []);
  assert.equal(runStep([job(1, 200), job(2, 301)]).warnings.length, 1);
});

test('a run without two successful shards has nothing to compare, and does not warn', () => {
  assert.deepEqual(runStep([]), { status: 0, warnings: [] });
  assert.deepEqual(runStep([job(1, 300), job(2, 30, { conclusion: 'failure' })]), { status: 0, warnings: [] });
});

test('the test step is timed, not the job: equal setup does not hide drift', () => {
  // 445 / 178 s of tests is 2.5x; with 600 s of setup on each the JOB ratio would be ~1.35x.
  assert.equal(runStep([job(1, 178, { setup: 600 }), job(2, 445, { setup: 600 })]).warnings.length, 1);
});

test('an unreadable run warns instead of failing', () => {
  const { status, warnings } = runStep([], 1);
  assert.equal(status, 0);
  assert.equal(warnings.length, 1);
});
