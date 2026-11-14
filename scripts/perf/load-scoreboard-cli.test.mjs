/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// End to end through the scoreboard's own entry point: `load-scoreboard.mjs
// report` over recorded samples must flag a real slowdown, pass a quiet A/A,
// and keep failed samples in the counts. Run as a subprocess, so the
// assertions are on what the tool prints and writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = 'scripts/perf/load-scoreboard.mjs';
// Five interleaved rounds with about +-2% scatter: the shape of a quiet cohort.
const A = [1000, 1012, 991, 1005, 998];
const B = [1003, 995, 1010, 999, 1006];

function recordedRun() {
  const out = mkdtempSync(join(tmpdir(), 'load-scoreboard-cli-'));
  const plan = { name: 'cli', kind: 'compare', lanes: ['native-cold'], rounds: 5, seed: 1,
    sides: { base: { label: 'base' }, branch: { label: 'branch' } },
    fixtures: [{ name: 'steady', set: 'tuning', bytes: 2 ** 20 }, { name: 'slower', set: 'tuning', bytes: 2 ** 20 }, { name: 'flaky', set: 'holdout', bytes: 2 ** 20 }] };
  const rows = [];
  for (let round = 0; round < 5; round++) {
    const row = (fixture, side, interactiveMs, extra = {}) => ({ group: 'native', lane: 'native-cold', fixture, round, side, ok: true,
      interactiveMs, peakMemoryMiB: 100, fingerprint: 'meshes=1', ...extra });
    rows.push(row('steady', 'base', A[round]), row('steady', 'branch', B[round]));
    rows.push(row('slower', 'base', A[round]), row('slower', 'branch', B[round] * 1.3));
    rows.push(row('flaky', 'base', A[round]),
      row('flaky', 'branch', B[round], round === 3 ? { ok: false, error: 'renderer crashed', interactiveMs: undefined } : {}));
  }
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(out, 'samples.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return out;
}

function report(out) {
  // stdout and the exit status only: the assertions below are the observation.
  const run = spawnSync(process.execPath, [CLI, 'report', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', written: existsSync(join(out, 'report.json')) };
}

test('the report CLI flags a 30% slowdown and passes a quiet A/A', () => {
  const out = recordedRun();
  try {
    const run = report(out);
    assert.equal(run.status, 0, `${CLI} report exited with status ${run.status}`);
    assert.equal(run.written, true, 'report.json was not written');
    const summary = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const verdict = (name) => summary.fixtures.find((f) => f.name === name)?.lanes['native-cold']?.primary?.verdict;
    assert.equal(verdict('slower'), 'regression');
    assert.equal(verdict('steady'), 'no significant difference');
    assert.match(run.stdout, /regressions \[[^\]]*\bslower\b/);
    assert.match(run.stdout, /no significant difference \[[^\]]*\bsteady\b/);
    assert.doesNotMatch(run.stdout, /regressions \[[^\]]*\bsteady\b/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the report CLI keeps a failed sample in the counts and treats it as a branch regression', () => {
  const out = recordedRun();
  try {
    const run = report(out);
    assert.equal(run.status, 0, `${CLI} report exited with status ${run.status}`);
    assert.equal(run.written, true, 'report.json was not written');
    const summary = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const lane = summary.fixtures.find((f) => f.name === 'flaky')?.lanes['native-cold'];
    assert.equal(lane?.sides.branch.failed, 1);
    assert.deepEqual(lane?.sides.branch.errors, ['r3: renderer crashed']);
    assert.equal(lane?.primary?.verdict, 'regression: more failed loads');
    assert.match(run.stdout, /## Verdicts \(holdout\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
