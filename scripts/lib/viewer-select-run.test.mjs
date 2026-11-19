/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected viewer tests' verdict and their one retry
 * (scripts/lib/viewer-select-run.mjs). The end-to-end cases drive
 * runSelectedTests with a fake `pnpm` that writes node:test TAP where
 * NODE_OPTIONS points it, so the retry path runs for real.
 *
 * Run: node --test scripts/lib/viewer-select-run.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planSelectedRetry, runSelectedTests, verdict, withTapReporter } from './viewer-select-run.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'viewer-select-run-'));

const tap = (root, { failed }) => [
  'TAP version 13',
  '# Subtest: flaky',
  failed ? 'not ok 1 - flaky' : 'ok 1 - flaky',
  '  ---',
  '  duration_ms: 1',
  ...(failed ? [`  location: '${root}/src/a.test.ts:3:1'`, "  failureType: 'testCodeFailure'", "  error: 'boom'"] : []),
  '  ...',
  '1..1',
  '# tests 1',
  '# suites 0',
  `# pass ${failed ? 0 : 1}`,
  `# fail ${failed ? 1 : 0}`,
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 5',
  '',
].join('\n');

test('withTapReporter appends one TAP file reporter to NODE_OPTIONS', () => {
  assert.equal(withTapReporter(undefined, '/t/a.tap'), '--test-reporter=tap --test-reporter-destination=/t/a.tap');
  assert.equal(withTapReporter('--max-old-space-size=4096', '/t/a.tap'), '--max-old-space-size=4096 --test-reporter=tap --test-reporter-destination=/t/a.tap');
});

test('verdict: a pass on the first attempt, or on the retry in `on` only, passes', () => {
  assert.deepEqual(verdict({ exitCode: 0, mode: 'off', retry: null }), { passed: true, failedFiles: [] });
  const retried = { plan: { retry: true }, files: ['src/a.test.ts'], result: { passed: true } };
  assert.deepEqual(verdict({ exitCode: 1, mode: 'on', retry: retried }), { passed: true, failedFiles: [], passedOnRetry: ['src/a.test.ts'] });
  assert.deepEqual(verdict({ exitCode: 1, mode: 'shadow', retry: retried }), { passed: false, failedFiles: ['src/a.test.ts'] }, 'shadow keeps the first verdict');
  assert.deepEqual(verdict({ exitCode: 1, mode: 'on', retry: { ...retried, result: { passed: false } } }), { passed: false, failedFiles: ['src/a.test.ts'] });
  assert.deepEqual(verdict({ exitCode: 1, mode: 'off', retry: null }), { passed: false, failedFiles: [] });
});

test('planSelectedRetry: refuses without a TAP, without job time, and for a file the run was not given', () => {
  const root = '/r/apps/viewer';
  const files = ['src/a.test.ts'];
  assert.equal(planSelectedRetry({ mode: 'on', tap: null, viewerRoot: root, files, budgetMs: 600_000 }).plan.retry, false);
  const ok = planSelectedRetry({ mode: 'on', tap: tap(root, { failed: true }), viewerRoot: root, files, budgetMs: 600_000 });
  assert.equal(ok.plan.retry, true);
  assert.deepEqual(ok.files, files);
  assert.match(planSelectedRetry({ mode: 'on', tap: tap(root, { failed: true }), viewerRoot: root, files, budgetMs: null }).plan.reason, /time left is unknown/);
  assert.match(planSelectedRetry({ mode: 'on', tap: tap(root, { failed: true }), viewerRoot: root, files, budgetMs: 10_000 }).plan.reason, /s of the job's time is left/);
  assert.match(planSelectedRetry({ mode: 'on', tap: tap(root, { failed: true }), viewerRoot: root, files: ['src/b.test.ts'], budgetMs: 600_000 }).plan.reason, /not given: src\/a\.test\.ts/);
  const off = planSelectedRetry({ mode: 'off', tap: tap(root, { failed: true }), viewerRoot: root, files, budgetMs: 600_000 });
  assert.equal(off.plan.retry, false);
  assert.deepEqual(off.files, files, 'off still names the failing file for the status');
});

/**
 * A fixture repo and a fake `pnpm` that fails its first `attempts` calls and
 * passes after, writing TAP where NODE_OPTIONS says.
 */
function fixture(failures) {
  const root = mkdtempSync(join(TMP, 'repo-'));
  mkdirSync(join(root, 'apps/viewer/src'), { recursive: true });
  const viewerRoot = realpathSync(join(root, 'apps/viewer'));
  const dir = join(root, 'sel');
  mkdirSync(dir);
  writeFileSync(join(dir, 'files.txt'), 'src/a.test.ts\n');
  const bin = mkdtempSync(join(TMP, 'bin-'));
  const counter = join(bin, 'calls');
  writeFileSync(counter, '0');
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
const failed = n <= ${failures};
const dest = /--test-reporter-destination=(\\S+)$/.exec(process.env.NODE_OPTIONS)[1];
fs.writeFileSync(dest, ${JSON.stringify(tap(viewerRoot, { failed: true }))}.replace(/^not ok 1/m, failed ? 'not ok 1' : 'ok 1').replace('# pass 0', failed ? '# pass 0' : '# pass 1').replace('# fail 1', failed ? '# fail 1' : '# fail 0'));
process.exit(failed ? 1 : 0);
`, { mode: 0o755 });
  return { root, dir, counter, env: { PATH: `${bin}:${process.env.PATH}`, JOB_STARTED_AT: String(Math.floor(Date.now() / 1000)), JOB_TIMEOUT_MINUTES: '20' } };
}

const runIt = ({ root, dir, env }, mode) => {
  const code = runSelectedTests({ root, viewer: 'apps/viewer', dir, env: { ...env, CI_SHARD_RETRY: mode }, runner: ['tsx', '--test'] });
  return { code, result: JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) };
};

test('runSelectedTests: a file that fails then passes on the `on` retry passes, and the run exits 0', () => {
  const f = fixture(1);
  const { code, result } = runIt(f, 'on');
  assert.equal(code, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.passed, true);
  assert.deepEqual(result.passedOnRetry, ['src/a.test.ts']);
  assert.equal(readFileSync(f.counter, 'utf8'), '2', 'one first attempt, one retry');
});

test('runSelectedTests: a file that fails twice fails, naming the file', () => {
  const { code, result } = runIt(fixture(2), 'on');
  assert.equal(code, 0, 'advisory to the run');
  assert.equal(result.passed, false);
  assert.deepEqual(result.failedFiles, ['src/a.test.ts']);
});

test('runSelectedTests: `off` does not retry; `shadow` retries but keeps the failure', () => {
  const off = fixture(1);
  assert.equal(runIt(off, 'off').result.passed, false);
  assert.equal(readFileSync(off.counter, 'utf8'), '1');
  const shadow = fixture(1);
  const r = runIt(shadow, 'shadow').result;
  assert.equal(r.passed, false);
  assert.equal(r.retry.result.passed, true);
  assert.equal(readFileSync(shadow.counter, 'utf8'), '2');
});
