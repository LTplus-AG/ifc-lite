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

/** Run the shipped step with `gh` printing `lines` (the step's own --jq output) and exiting `status`. */
function runStep(lines, status = 0) {
  assert.ok(STEP, 'test-red-on-main.yml has no shard-drift step');
  const dir = mkdtempSync(join(tmpdir(), 'shard-drift-'));
  try {
    writeFileSync(join(dir, 'out.txt'), lines.map((l) => `${l}\n`).join(''));
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncat '${join(dir, 'out.txt')}'\nexit ${status}\n`);
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

const job = (n, seconds) => `Node scripts tests (shard ${n}/2)\t${seconds}`;

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
  assert.deepEqual(runStep([job(1, 300)]), { status: 0, warnings: [] });
});

test('an unreadable run warns instead of failing', () => {
  const { status, warnings } = runStep([], 1);
  assert.equal(status, 0);
  assert.equal(warnings.length, 1);
});
