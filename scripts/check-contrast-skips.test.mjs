/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A contrast test skipped for want of a browser must fail a CI viewer shard
// and end a local run with a visible count, never read as a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContrastSkips } from './check-contrast-skips.mjs';
import { CONTRAST_SKIP_MARKER, contrastSkipSummary, countJunitContrastSkips, nodeOptionsReportToStdout } from './lib/contrast-skips.mjs';

const REPORTER = fileURLToPath(new URL('./lib/contrast-skips.mjs', import.meta.url));
const GATE = fileURLToPath(new URL('./check-contrast-skips.mjs', import.meta.url));
const REASON = `${CONTRAST_SKIP_MARKER} neither Google Chrome nor Playwright's Chromium found, browser tests skipped (CI fails instead).`;

/** A real `node --test` run: one pass, `contrastSkips` harness skips, one unrelated skip. */
function runFixture(t, contrastSkips, { env = {}, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'contrast-skips-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = Array.from({ length: contrastSkips }, (_, i) => `it('browser ${i}', { skip: ${JSON.stringify(REASON)} }, () => {});`);
  writeFileSync(join(dir, 'f.test.mjs'), [
    "import { it } from 'node:test';",
    "it('runs', () => {});",
    "it('fixture gone', { skip: 'fixture absent' }, () => {});",
    ...cases,
  ].join('\n'));
  // NODE_TEST_CONTEXT, inherited from this runner, would make the child report
  // to it and ignore its own reporters.
  const { NODE_TEST_CONTEXT: _parent, ...inherited } = process.env;
  const run = spawnSync(process.execPath, ['--test', ...args, 'f.test.mjs'], {
    cwd: dir, encoding: 'utf8', env: { ...inherited, NODE_OPTIONS: '', ...env },
  });
  return { dir, run };
}

function junitFixture(t, contrastSkips) {
  const { dir, run } = runFixture(t, contrastSkips, { args: ['--test-reporter=junit', '--test-reporter-destination=report.xml'] });
  assert.equal(run.status, 0, run.stderr);
  return join(dir, 'report.xml');
}

test("counts only the harness's skips in node's own JUnit report", (t) => {
  assert.equal(countJunitContrastSkips(readFileSync(junitFixture(t, 3), 'utf8')), 3);
  assert.equal(countJunitContrastSkips(readFileSync(junitFixture(t, 0), 'utf8')), 0);
});

test('the CI gate fails on any contrast skip and passes on none', (t) => {
  const failing = checkContrastSkips([junitFixture(t, 1)]);
  assert.equal(failing.ok, false);
  assert.match(failing.message, /1 contrast test\(s\) SKIPPED/);
  assert.equal(checkContrastSkips([junitFixture(t, 0)]).ok, true);
});

test('the CI gate fails when the report is missing or not named, and exits 1 from the command line', (t) => {
  assert.equal(checkContrastSkips([]).ok, false);
  assert.match(checkContrastSkips(['/nonexistent/report.xml']).message, /not found/);
  const cli = spawnSync(process.execPath, [GATE, junitFixture(t, 2)], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /2 contrast test\(s\) SKIPPED/);
  assert.equal(spawnSync(process.execPath, [GATE, junitFixture(t, 0)], { encoding: 'utf8' }).status, 0);
});

test('a local run keeps its normal output and ends with the skip count', (t) => {
  const { run } = runFixture(t, 2, { args: [`--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\bruns\b/, "node's default output is still rendered");
  assert.match(run.stdout, /# skipped 3/);
  assert.ok(run.stdout.trimEnd().endsWith(contrastSkipSummary(2)), run.stdout.slice(-300));
});

test('a run with no contrast skips prints no summary line', (t) => {
  const { run } = runFixture(t, 0, { args: [`--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'] });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /contrast test\(s\) SKIPPED/);
});

test('when NODE_OPTIONS already picks reporters (CI) it adds only the summary, not a second copy of the output', (t) => {
  const { run } = runFixture(t, 1, {
    env: { NODE_OPTIONS: '--test-reporter=tap --test-reporter-destination=stdout' },
    args: [`--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.match(/^ok 1 - runs$/gm)?.length, 1);
  assert.match(run.stdout, /1 contrast test\(s\) SKIPPED/);
});

test('only a NODE_OPTIONS reporter that writes to stdout suppresses the default output', () => {
  assert.equal(nodeOptionsReportToStdout(''), false);
  assert.equal(nodeOptionsReportToStdout(undefined), false);
  assert.equal(nodeOptionsReportToStdout('--max-old-space-size=4096'), false);
  assert.equal(nodeOptionsReportToStdout('--test-reporter=junit --test-reporter-destination=out.xml'), false);
  assert.equal(nodeOptionsReportToStdout('--test-reporter=tap'), true);
  assert.equal(nodeOptionsReportToStdout('--test-reporter=tap --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=mergify-junit.xml'), true);
});

test('with only a file reporter in NODE_OPTIONS the console output is still rendered', (t) => {
  const { run } = runFixture(t, 1, {
    env: { NODE_OPTIONS: '--test-reporter=junit --test-reporter-destination=out.xml' },
    args: [`--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /runs/);
  assert.match(run.stdout, /1 contrast test\(s\) SKIPPED/);
});
