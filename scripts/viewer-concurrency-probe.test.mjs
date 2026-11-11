/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * VIEWER_TEST_CONCURRENCY and the concurrency probe: the variable reaches
 * `--test-concurrency` through apps/viewer's real `test` script, bounded the
 * same way the gate bounds it; the probe counts the files that REPORTED a
 * result (a real node:test run through the real reporter); the report fails
 * on any shortfall or failure; and the probe workflow is off, hosted-only and
 * outside the Test run.
 *
 * Run: node --test scripts/viewer-concurrency-probe.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { parseTap, readRecords, report, reportedFiles, scriptConcurrency, selectFiles, selectionCommand, viewerTestScript } from './viewer-concurrency-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const VIEWER = join(REPO_ROOT, 'apps/viewer');
const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');
const FILE_REPORTER = join(HERE, 'lib/test-file-reporter.mjs');
const TEST_YML = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
const PROBE_YML = parse(readFileSync(join(REPO_ROOT, '.github/workflows/viewer-concurrency-probe.yml'), 'utf8'));
const TMP = mkdtempSync(join(tmpdir(), 'viewer-concurrency-probe-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ------------------------------------------------- the variable, for real

/** The `--test-concurrency` flags apps/viewer's `test` script passes, with `tsx` replaced by a stub that prints its argv. */
function concurrencyArgs(extraEnv) {
  const stub = join(TMP, 'tsx');
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);
  const { VIEWER_TEST_CONCURRENCY: _drop, ...env } = process.env;
  const r = spawnSync('sh', ['-c', viewerTestScript()], {
    cwd: VIEWER,
    encoding: 'utf8',
    env: { ...env, PATH: `${TMP}:${env.PATH}`, TEST_SHARDS: '', TEST_SHARD: '', TEST_PATTERN: '', ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((a) => a.startsWith('--test-concurrency=')); // @source-text-assertion-ok filters the argv a stub tsx received, not a source file
}

test("apps/viewer's script bounds VIEWER_TEST_CONCURRENCY: only 2, 3 or 4 change anything, everything else is 1", () => {
  for (const [v, want] of [[undefined, '1'], ['', '1'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '1'], ['8', '1'], [' 2', '1'], ['2 ', '1'], ['two', '1'], ['0', '1'], ['-1', '1'], ['2;rm', '1']]) {
    const env = v === undefined ? {} : { VIEWER_TEST_CONCURRENCY: v };
    assert.deepEqual(concurrencyArgs(env), [`--test-concurrency=${want}`], JSON.stringify(v));
    const { VIEWER_TEST_CONCURRENCY: _d, ...base } = process.env;
    assert.equal(scriptConcurrency({ ...base, TEST_SHARDS: '', TEST_SHARD: '', ...env }), want, `the probe records what the script ran, ${JSON.stringify(v)}`);
  }
});

test('the gate step hands the repo variable to that script, which is the one place it is bounded', () => {
  const env = TEST_YML.jobs['viewer-tests'].steps.find((s) => s.id === 'viewer_tests').env;
  // A GitHub Actions expression, compared as written.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(env.VIEWER_TEST_CONCURRENCY, '${{ vars.VIEWER_TEST_CONCURRENCY }}');
  assert.equal(TEST_YML.jobs['viewer-tests'].strategy.matrix.shard.length, 16, 'the gate keeps sixteen shards');
});

// ------------------------------ what ran, through the real reporter

/** Run node:test over scratch files with the probe's file reporter; return what it wrote. */
function reporterRun(name, files) {
  const root = join(TMP, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const out = join(root, 'files.json');
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  const entries = Object.keys(files).filter((f) => /\.test\.tsx?$/.test(f)).sort(); // @source-text-assertion-ok picks test entrypoints from the fixture's own file names
  spawnSync(TSX, ['--test', '--test-concurrency=2', ...entries], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, NODE_OPTIONS: `--test-reporter=tap --test-reporter-destination=/dev/null --test-reporter=${FILE_REPORTER} --test-reporter-destination=${out}` },
  });
  return { root: realpathSync(root), text: readFileSync(out, 'utf8') };
}

test('#9791 review: the probe counts every file whose run completed: passing, crashing on import, only skipped, or with its tests declared in a helper', () => {
  const { root, text } = reporterRun('reported', {
    'src/a.test.ts': "import test from 'node:test';\ntest('a', () => {});\ntest.describe('g', () => { test('n', () => {}); });\n",
    'src/b.test.ts': "import './missing-module.js';\n",
    'src/d/c.test.tsx': "import test from 'node:test';\ntest.skip('s', () => {});\n",
    // The shape of apps/viewer's i18n catalogue tests: `test()` is called in
    // a helper, so the TESTS' file is the helper. /code-review on #9791.
    'src/e.test.ts': "import { contract } from './helpers/contract.ts';\ncontract();\n",
    'src/helpers/contract.ts': "import test from 'node:test';\nexport function contract() { test('h', () => {}); }\n",
  });
  assert.deepEqual(reportedFiles(text, root), ['src/a.test.ts', 'src/b.test.ts', 'src/d/c.test.tsx', 'src/e.test.ts']);
});

test('#9791 review: a runner that wrote no file list (killed mid-shard) reported nothing, and the report fails on it', () => {
  assert.throws(() => reportedFiles('not json', '/x'), 'garbled output is an error the caller logs, not silently no files');
  assert.throws(() => reportedFiles('{"a":1}', '/x'));
  const selected = ['src/a.test.ts', 'src/b.test.ts'];
  assert.equal(report([rec(0, selected, { reported: [] })], selected, 1).complete, false);
});

test('#9791 CodeRabbit: no record directory (every shard failed before uploading) is no records, so the report still names the missing shards', () => {
  const records = readRecords(join(TMP, 'never-downloaded'));
  assert.deepEqual(records, []);
  const out = report(records, ['a'], 8);
  assert.equal(out.complete, false);
  assert.ok(out.lines.some((l) => l.includes('8 shard record(s) missing'))); // @source-text-assertion-ok subject is the generated report
  assert.throws(() => readRecords(join(VIEWER, 'package.json')), 'a path that is not a directory is not "no records"');
});

// --------------------------------------- coverage against the real tree

test('on the real tree, the probe\'s 8 shards select every viewer test file exactly once', () => {
  // Selection only: what RAN is counted by the reporter (tested above).
  const base = { ...process.env, TEST_PATTERN: '' };
  const all = selectFiles({ ...base, TEST_SHARDS: '', TEST_SHARD: '' });
  const records = Array.from({ length: 8 }, (_, s) => rec(s, selectFiles({ ...base, TEST_SHARDS: '8', TEST_SHARD: String(s) })));
  const out = report(records, all, 8);
  assert.equal(out.complete, true, out.lines.join('\n'));
});

// --------------------------------------------------------- the report

function rec(shard, files, extra = {}) {
  return {
    shard, reported: files, jobStartedAt: 1_000, endedAt: 1_000 + 120_000, testStepSeconds: 100, exitCode: 0, concurrency: '2',
    counts: { tests: files.length, pass: files.length, fail: 0, cancelled: 0 }, failures: [], ...extra,
  };
}

test('the report computes wall time and job-minutes from the shard records', () => {
  const out = report([rec(0, ['a']), rec(1, ['b'], { jobStartedAt: 31_000, endedAt: 241_000 })], ['a', 'b'], 2);
  assert.equal(out.complete, true);
  assert.ok(out.lines.some((l) => l.includes('| 4.0 min |')), 'wall: 1 s to 241 s'); // @source-text-assertion-ok subject is the generated report
  assert.ok(out.lines.some((l) => l.includes('| 5.5 |')), 'job-minutes: 2.0 + 3.5'); // @source-text-assertion-ok subject is the generated report
});

test('the report fails on a missing shard, a file that never reported, a duplicate, a file the gate does not run, and no records', () => {
  assert.equal(report([rec(0, ['a'])], ['a', 'b'], 2).complete, false, 'shard 1 missing');
  assert.equal(report([rec(0, ['a']), rec(1, ['b'], { reported: [] })], ['a', 'b'], 2).complete, false, 'b selected, never reported');
  assert.equal(report([rec(0, ['a', 'b']), rec(1, ['b'])], ['a', 'b'], 2).complete, false, 'b reported twice');
  assert.equal(report([rec(0, ['a']), rec(1, ['b', 'helper.ts'])], ['a', 'b'], 2).complete, false, 'a path the gate does not run');
  assert.equal(report([], ['a'], 2).complete, false, 'no records at all');
});

test('the report names failing shards and their failed tests, and a crashed shard with no TAP counts', () => {
  const out = report([rec(0, ['a'], { exitCode: 1, counts: { tests: 1, pass: 0, fail: 1, cancelled: 0 }, failures: ['src/a.test.ts'] }), rec(1, ['b'], { counts: null })], ['a', 'b'], 2);
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

test('#9791 review: the probe is its own workflow, after a main push Test run, and OFF unless the switch is exactly `on`', () => {
  assert.deepEqual(Object.keys(TEST_YML.jobs).filter((j) => j.includes('probe')), [], 'nothing of the probe left in the Test run'); // @source-text-assertion-ok filters parsed job keys
  assert.deepEqual(PROBE_YML.on.workflow_run, { workflows: ['Test'], types: ['completed'], branches: ['main'] });
  const { plan, ...rest } = PROBE_YML.jobs;
  const conjuncts = plan.if.split(' && ');
  assert.ok(!plan.if.includes('||'), 'a top-level || could switch it on without the variable'); // @source-text-assertion-ok the parsed job condition is the subject
  for (const c of [
    "vars.VIEWER_CONCURRENCY_PROBE == 'on'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ]) assert.ok(conjuncts.includes(c), c); // @source-text-assertion-ok checks the parsed job condition's conjuncts
  // Every other job needs `plan` and requires its output, so with `plan`
  // skipped (switch unset) nothing runs, not even under `!cancelled()`.
  for (const [name, job] of Object.entries(rest)) {
    assert.ok([job.needs].flat().includes('plan'), `${name} needs plan`);
    const own = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '').split(' && ');
    assert.ok(own.includes("needs.plan.outputs.viewer_tested == 'true'"), `${name} requires plan's output`);
  }
});

test('#9791 review: the probe runs only on GitHub-hosted runners, read-only, with no stored credentials', () => {
  for (const [name, job] of Object.entries(PROBE_YML.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest', name);
    for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) { // @source-text-assertion-ok selects checkout steps from the parsed workflow
      assert.equal(step.with['persist-credentials'], false, name);
    }
  }
  assert.deepEqual(PROBE_YML.permissions, { actions: 'read', contents: 'read' });
  const shard = PROBE_YML.jobs.probe.steps.find((s) => s.run === 'node scripts/viewer-concurrency-probe.mjs --shard');
  assert.equal(shard.env.VIEWER_TEST_CONCURRENCY, '2');
  assert.equal(shard.env.TEST_SHARDS, '8');
  assert.equal(PROBE_YML.jobs.probe.strategy.matrix.shard.length, 8);
});
