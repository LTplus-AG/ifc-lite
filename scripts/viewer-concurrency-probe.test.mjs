/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * VIEWER_TEST_CONCURRENCY and the advisory concurrency probe: the variable
 * reaches `--test-concurrency` through apps/viewer's real `test` script, the
 * probe's 8-shard split runs exactly the files the 16-shard gate runs, the
 * report flags every way coverage can fall short, and the probe cannot touch
 * the aggregate.
 *
 * Run: node --test scripts/viewer-concurrency-probe.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { GATE_SHARDS, parseTap, report, selectFiles, selectionCommand } from './viewer-concurrency-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const VIEWER = join(REPO_ROOT, 'apps/viewer');
const WORKFLOW = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
const TMP = mkdtempSync(join(tmpdir(), 'viewer-concurrency-probe-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ------------------------------------------------- the variable, for real

/** The `--test-concurrency` flags apps/viewer's `test` script passes, with `tsx` replaced by a stub that prints its argv. */
function runTestScriptArgs(extraEnv) {
  const stub = join(TMP, 'tsx');
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);
  const script = JSON.parse(readFileSync(join(VIEWER, 'package.json'), 'utf8')).scripts.test;
  const { VIEWER_TEST_CONCURRENCY: _drop, ...env } = process.env;
  const r = spawnSync('sh', ['-c', script], {
    cwd: VIEWER,
    encoding: 'utf8',
    env: { ...env, PATH: `${TMP}:${env.PATH}`, TEST_SHARDS: '', TEST_SHARD: '', TEST_PATTERN: '^src/hooks/useSandbox[.]ts$|useSandbox[.]runSupersession[.]test[.]tsx$', ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((a) => a.startsWith('--test-concurrency=')); // @source-text-assertion-ok filters the argv a stub tsx received, not a source file
}

test('unset VIEWER_TEST_CONCURRENCY runs the viewer suite at concurrency 1, as before', () => {
  assert.deepEqual(runTestScriptArgs({}), ['--test-concurrency=1']);
  assert.deepEqual(runTestScriptArgs({ VIEWER_TEST_CONCURRENCY: '' }), ['--test-concurrency=1']);
});

test('VIEWER_TEST_CONCURRENCY reaches --test-concurrency', () => {
  assert.deepEqual(runTestScriptArgs({ VIEWER_TEST_CONCURRENCY: '2' }), ['--test-concurrency=2']);
});

test('the gate passes the repo variable through only for 2, 3 or 4; anything else is 1', () => {
  const env = WORKFLOW.jobs['viewer-tests'].steps.find((s) => s.id === 'viewer_tests').env;
  assert.equal(env.VIEWER_TEST_CONCURRENCY, `\${{ contains(fromJSON('["2","3","4"]'), vars.VIEWER_TEST_CONCURRENCY) && vars.VIEWER_TEST_CONCURRENCY || '1' }}`);
  // The same rule in JS (Actions' contains() on an array is case-insensitive equality on strings).
  const resolve = (v) => (['2', '3', '4'].includes(String(v ?? '').toLowerCase()) ? v : '1');
  for (const [v, want] of [[undefined, '1'], ['', '1'], ['1', '1'], ['2', '2'], ['4', '4'], ['5', '1'], [' 2', '1'], ['two', '1'], ['0', '1']]) {
    assert.equal(resolve(v), want, JSON.stringify(v));
  }
});

// --------------------------------------- coverage against the real tree

test('the probe\'s 8 shards run exactly the files the 16-shard gate runs, each once', () => {
  const base = { ...process.env, TEST_PATTERN: '' };
  const all = selectFiles({ ...base, TEST_SHARDS: '', TEST_SHARD: '' });
  let gateCount = 0;
  for (let s = 0; s < GATE_SHARDS; s++) gateCount += selectFiles({ ...base, TEST_SHARDS: String(GATE_SHARDS), TEST_SHARD: String(s) }).length;
  const records = Array.from({ length: 8 }, (_, s) => ({
    shard: s,
    files: selectFiles({ ...base, TEST_SHARDS: '8', TEST_SHARD: String(s) }),
    jobStartedAt: 0,
    endedAt: 60_000,
    testStepSeconds: 50,
    exitCode: 0,
    concurrency: '2',
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0 },
    failures: [],
  }));
  assert.equal(gateCount, all.length);
  const out = report(records, all, gateCount, 8);
  assert.equal(out.complete, true, out.lines.join('\n'));
  assert.equal(out.failed, 0);
});

// --------------------------------------------------------- the report

const rec = (shard, files, extra = {}) => ({
  shard, files, jobStartedAt: 1_000, endedAt: 1_000 + 120_000, testStepSeconds: 100, exitCode: 0, concurrency: '2',
  counts: { tests: files.length, pass: files.length, fail: 0, cancelled: 0 }, failures: [], ...extra,
});

test('the report computes wall time and job-minutes from the shard records', () => {
  const out = report([rec(0, ['a']), rec(1, ['b'], { jobStartedAt: 31_000, endedAt: 241_000 })], ['a', 'b'], 2, 2);
  assert.equal(out.complete, true);
  assert.ok(out.lines.some((l) => l.includes('| 4.0 min |')), 'wall: 1 s to 241 s'); // @source-text-assertion-ok subject is the generated report
  assert.ok(out.lines.some((l) => l.includes('| 5.5 |')), 'job-minutes: 2.0 + 3.5'); // @source-text-assertion-ok subject is the generated report
});

test('the report flags a missing shard, an unrun file, a duplicate and a count that differs from the gate', () => {
  assert.equal(report([rec(0, ['a'])], ['a', 'b'], 2, 2).complete, false, 'shard 1 missing, b not run');
  assert.equal(report([rec(0, ['a', 'b']), rec(1, ['b'])], ['a', 'b'], 2, 2).complete, false, 'b ran twice');
  assert.equal(report([rec(0, ['a']), rec(1, ['b'])], ['a', 'b'], 3, 2).complete, false, 'gate runs 3');
  assert.equal(report([], ['a'], 1, 2).complete, false, 'no records at all');
});

test('the report names failing shards and their failed tests, and a crashed shard with no TAP counts', () => {
  const out = report([rec(0, ['a'], { exitCode: 1, counts: { tests: 1, pass: 0, fail: 1, cancelled: 0 }, failures: ['src/a.test.ts'] }), rec(1, ['b'], { counts: null })], ['a', 'b'], 2, 2);
  assert.equal(out.failed, 2);
  assert.ok(out.lines.some((l) => l.includes('`src/a.test.ts`'))); // @source-text-assertion-ok subject is the generated report
});

test('parseTap reads the closing counts and only top-level failures', () => {
  const tap = ['TAP version 13', '    not ok 1 - nested', 'not ok 1 - src/a.test.ts', 'not ok 2 - later # TODO x', 'ok 3 - fine', '# tests 3', '# pass 1', '# fail 1', '# cancelled 0'].join('\n');
  const { counts, failures } = parseTap(tap);
  assert.deepEqual(failures, ['src/a.test.ts']);
  assert.equal(counts.fail, 1);
  assert.equal(parseTap('TAP version 13\n').counts, null);
});

test('selectionCommand refuses a test script it cannot cut', () => {
  assert.throws(() => selectionCommand('tsx --test $files'));
});

// ---------------------------------------------------------- the wiring

test('the probe is push-only, switchable, advisory and outside the aggregate', () => {
  const probe = WORKFLOW.jobs['viewer-concurrency-probe'];
  const reportJob = WORKFLOW.jobs['viewer-concurrency-probe-report'];
  for (const job of [probe, reportJob]) {
    assert.match(job.if, /github\.event_name == 'push'/);
    assert.equal(job['continue-on-error'], true);
  }
  assert.match(probe.if, /vars\.VIEWER_CONCURRENCY_PROBE != 'off'/); // @source-text-assertion-ok the parsed job condition is the subject
  assert.equal(probe.strategy.matrix.shard.length, 8);
  const run = probe.steps.find((s) => s.run?.includes('viewer-concurrency-probe.mjs --shard')); // @source-text-assertion-ok selects the step from the parsed workflow
  assert.equal(run.env.VIEWER_TEST_CONCURRENCY, '2');
  assert.equal(run.env.TEST_SHARDS, '8');
  const needs = WORKFLOW.jobs.test.needs;
  assert.deepEqual(needs.filter((j) => j.startsWith('viewer-concurrency-probe')), []); // @source-text-assertion-ok filters the parsed needs list
  // The gate's shard count is untouched.
  assert.equal(WORKFLOW.jobs['viewer-tests'].strategy.matrix.shard.length, 16);
});
