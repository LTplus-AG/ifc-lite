/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shard retry switch: the mode, the failure attribution (against TAP that
 * node:test really emits), the retry selection (through the real awk and
 * shard selector apps/viewer's test script uses), the pass/fail judgements,
 * the CLI's refusals, and the test.yml wiring.
 *
 * Run: node --test scripts/ci-shard-retry.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { MANIFEST_PATH, assignShards, parseManifest } from './viewer-test-shards.mjs';

// When the revert oracle reverses this PR's production files, every test must
// still run and fail on its own assertion, not the whole file at load with
// nothing asserted (as in scripts/perf/load-scoreboard-stats.test.mjs). So a
// failed import becomes members that fail when used. Only the error NAME is
// reported: the oracle reads a "Cannot find module" message as a load failure.
// `then` stays undefined, or awaiting the stub would call it.
const guarded = (path) => import(path).catch((err) => new Proxy({}, {
  get: (_, key) => (key === 'then' ? undefined : () => assert.fail(`${path} did not load (${err.name})`)),
}));
const { run } = await guarded('./ci-shard-retry.mjs');
const {
  MAX_RETRY_FILES,
  attributeViewerFailures,
  decideMode,
  incompleteE2eAttempt,
  incompleteViewerAttempt,
  indexPlaywrightReport,
  judgeE2eRetry,
  judgeViewerRetry,
  parseNodeTap,
  planRetry,
  readLastRun,
  unintendedSkips,
  viewerPattern,
  oneLine,
} = await guarded('./lib/shard-retry.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const VIEWER = join(REPO_ROOT, 'apps/viewer');
const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');
const WORKFLOW = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'ci-shard-retry-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- the switch

test('unset, empty and `off` mean no retry; `shadow` and `on` in any case are modes', () => {
  for (const raw of [undefined, '', 'off', 'OFF']) assert.deepEqual(decideMode(raw), { mode: 'off' }, String(raw));
  assert.equal(decideMode('shadow').mode, 'shadow');
  assert.equal(decideMode('On').mode, 'on');
});

test('any other value is `off`, with a warning', () => {
  for (const raw of ['true', '1', ' on', 'on ', 'enabled', 'shadwo']) {
    const d = decideMode(raw);
    assert.equal(d.mode, 'off', JSON.stringify(raw));
    assert.ok(d.warning, JSON.stringify(raw));
  }
});

// ------------------------------------------------- attribution, on real TAP

/** Run node:test over `files` in a scratch tree the way apps/viewer does, return its TAP. */
function realTap(name, files) {
  const root = join(TMP, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  // Without NODE_TEST_CONTEXT, which this runner sets and which would make the
  // nested run report to it instead of printing TAP.
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  const r = spawnSync(TSX, ['--test', '--test-concurrency=1', ...Object.keys(files).filter((f) => f.includes('.test.')).sort()], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, NODE_OPTIONS: '--test-reporter=tap' },
  });
  // node reports locations by real path (macOS tmpdir is a symlink); so does the CLI.
  return { root: realpathSync(root), tap: r.stdout, status: r.status };
}

test('real node:test TAP: a nested assertion, an import crash and a non-zero exit are each tied to their file', () => {
  const { root, tap, status } = realTap('mixed', {
    'src/a.test.ts': "import test from 'node:test'; import assert from 'node:assert';\ntest('fine', () => {});\ntest.describe('group', () => { test('nested fails', () => { assert.equal(1, 2); }); });\n",
    'src/b.test.ts': "import test from 'node:test';\ntest('b ok', () => {});\n",
    'src/c.test.ts': "import './missing-module.js';\n",
    'src/d/e.test.tsx': "import test from 'node:test';\ntest('passes, then the file exits 1', () => { process.exitCode = 1; });\n",
    'src/f.test.ts': "import test from 'node:test';\ntest('times out', { timeout: 50 }, () => new Promise(() => {}));\n",
    // /code-review on #9788: node counts a test() whose subtest failed, but not
    // a describe suite whose before() threw (its tests count as cancelled), and
    // a test's stdout reaches TAP as `# ...` lines that look like counts.
    'src/g.test.ts': "import test from 'node:test';\ntest('parent', async (t) => { await t.test('child', () => { throw new Error('x'); }); });\ntest('parent 2', async (t) => { await t.test('child 2', () => { throw new Error('y'); }); });\n",
    'src/h.test.ts': "import { describe, it, before } from 'node:test';\ndescribe('suite', () => { before(() => { throw new Error('h'); }); it('t1', () => {}); it('t2', () => {}); });\n",
    'src/i.test.ts': "import test from 'node:test';\ntest('prints counts', () => { console.log('tests 99'); console.log('fail 0'); });\n",
  });
  assert.equal(status, 1);
  const { failures, summary } = parseNodeTap(tap);
  assert.equal(incompleteViewerAttempt({ failures, summary }), null, 'a complete run: listed failures equal fail + cancelled');
  assert.ok(summary, 'the closing counts are parsed');
  assert.equal(summary.pass, 4);
  assert.notEqual(summary.tests, 99, "a test's printed `tests 99` is not the summary");
  const a = attributeViewerFailures(failures, root);
  assert.deepEqual(a.unattributed, []);
  assert.deepEqual(a.files, ['src/a.test.ts', 'src/c.test.ts', 'src/d/e.test.tsx', 'src/f.test.ts', 'src/g.test.ts', 'src/h.test.ts']);
  assert.ok(a.tests.some((t) => t.file === 'src/a.test.ts' && t.title === 'nested fails'));
  assert.ok(!a.tests.some((t) => t.title === 'group'), 'a parent suite that failed only through its child is not a test of its own');
});

test('real node:test TAP of a green run has no failures and a complete summary', () => {
  const { tap } = realTap('green', { 'src/ok.test.ts': "import test from 'node:test';\ntest('ok', () => {});\n" });
  const { failures, summary } = parseNodeTap(tap);
  assert.deepEqual(failures, []);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary }).passed, true);
});

test('#9788 review: a first attempt cut off before its summary (runner killed) is not retried', () => {
  const { tap } = realTap('killed', {
    'src/a.test.ts': "import test from 'node:test'; import assert from 'node:assert';\ntest('fails', () => assert.equal(1, 2));\n",
    'src/b.test.ts': "import test from 'node:test';\ntest('never reached when killed', () => {});\n",
  });
  // A killed runner leaves exactly what it had printed so far: the first
  // file's `not ok` and none of the closing counts (reproduced with SIGTERM,
  // SIGINT and SIGKILL against tsx --test). Cut the real stream there.
  const killed = tap.slice(0, tap.indexOf('# Subtest: never reached when killed')); // @source-text-assertion-ok cuts real runner output, not a source file
  const parsed = parseNodeTap(killed);
  assert.equal(parsed.failures.length, 1);
  assert.match(incompleteViewerAttempt(parsed) ?? '', /no closing summary/); // @source-text-assertion-ok subject is the returned refusal
  assert.equal(incompleteViewerAttempt(parseNodeTap(tap)), null, 'the same run, uncut, is complete');
});

test('#9788 review: a summary that counts more failures than were listed is not retried', () => {
  const tap = 'not ok 1 - src/a.test.ts\n# tests 3\n# pass 1\n# fail 2\n# cancelled 0\n# duration_ms 1\n';
  assert.match(incompleteViewerAttempt(parseNodeTap(tap)) ?? '', /lists 1 failure\(s\) but its summary counts 2/); // @source-text-assertion-ok subject is the returned refusal
});

test('a failure outside a viewer test file, or with no location, is unattributed', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - helper failure',
    '  ---',
    "  location: '/repo/apps/viewer/src/test/helper.ts:3:1'",
    '  ...',
    '    not ok 1 - nested without location',
    'not ok 2 - src/../../etc/x.test.ts',
    'not ok 3 - todo # TODO later',
    '# tests 3',
  ].join('\n');
  const a = attributeViewerFailures(parseNodeTap(tap).failures, '/repo/apps/viewer');
  assert.deepEqual(a.files, []);
  assert.deepEqual(a.unattributed, ['helper failure', 'nested without location', 'src/../../etc/x.test.ts']);
});

test('a truncated TAP stream has no summary, so a retry cannot be judged passed from it', () => {
  const { summary } = parseNodeTap('TAP version 13\nok 1 - a\n# tests 1\n# pass 1\n');
  assert.equal(summary, null);
  // Counts without the closing `# duration_ms` are not the run's summary.
  assert.equal(parseNodeTap('not ok 1 - src/a.test.ts\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n').summary, null);
  // Counts a test printed, then more results and no closing block: still no summary.
  const printed = parseNodeTap('not ok 1 - src/a.test.ts\n# tests 9\n# pass 0\n# fail 1\n# cancelled 0\n# duration_ms 5\nok 2 - later\n');
  assert.equal(printed.summary, null);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary }).passed, false);
});

// --------------------------------------------- selection, through real awk

const VIEWER_TEST_SCRIPT = JSON.parse(readFileSync(join(VIEWER, 'package.json'), 'utf8')).scripts.test;
const TSX_AT = VIEWER_TEST_SCRIPT.indexOf(' && tsx '); // @source-text-assertion-ok anchor for cutting the real command before tsx; asserted below
/** apps/viewer's own file-selection pipeline, stopped before tsx. */
const SELECT = `${VIEWER_TEST_SCRIPT.slice(0, TSX_AT)} && printf '%s\\n' "$files"`;

test('the pattern selects exactly the given paths through awk -v, and nothing that differs by one character', () => {
  const want = ['src/a.test.ts', 'src/d/e-f_g.test.tsx'];
  const near = ['src/a.test.tsx', 'src/aXtest.ts', 'src/a.test.ts.bak', 'xsrc/a.test.ts', 'src/d/e-f_g.test.ts', 'src/sub/a.test.ts'];
  const r = spawnSync('awk', ['-v', `p=${viewerPattern(want)}`, '$0 ~ p'], { input: [...near, ...want].join('\n') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), want);
});

test('a path with other punctuation is refused, not escaped', () => {
  for (const bad of ['src/a b.test.ts', 'src/a(1).test.ts', 'src/a\\.test.ts', 'src/[x].test.ts']) assert.throws(() => viewerPattern([bad]), JSON.stringify(bad));
  assert.throws(() => viewerPattern([]));
});

test("through apps/viewer's real selection, the retry pattern runs exactly the failed file in its own shard, and nothing in another", () => {
  assert.ok(TSX_AT > 0, "apps/viewer's test script no longer selects files before `&& tsx`");
  const listed = spawnSync('sh', ['-c', SELECT], { cwd: VIEWER, encoding: 'utf8', env: { ...process.env, TEST_SHARDS: '', TEST_SHARD: '' } });
  assert.equal(listed.status, 0, listed.stderr);
  const all = listed.stdout.trim().split('\n');
  const file = all[Math.floor(all.length / 2)];
  const shard = assignShards(all, parseManifest(readFileSync(MANIFEST_PATH, 'utf8')), 16).get(file);
  const select = (s) => spawnSync('sh', ['-c', SELECT], { cwd: VIEWER, encoding: 'utf8', env: { ...process.env, TEST_SHARDS: '16', TEST_SHARD: String(s), TEST_PATTERN: viewerPattern([file]) } });
  const own = select(shard);
  assert.equal(own.status, 0, own.stderr);
  assert.deepEqual(own.stdout.trim().split('\n'), [file]);
  const other = select((shard + 1) % 16);
  assert.notEqual(other.status, 0, 'a pattern that selects nothing in this shard fails, never falls back to every file');
});

// ------------------------------------------------------------ the decisions

test('planRetry retries only an attributed, bounded failure, and only in shadow or on', () => {
  assert.equal(planRetry({ mode: 'off', count: 1, cap: 5 }).retry, false);
  assert.equal(planRetry({ mode: 'on', count: 1, cap: 5, refusal: 'x' }).retry, false);
  assert.equal(planRetry({ mode: 'on', count: 1, cap: 5, unattributed: ['t'] }).retry, false);
  assert.equal(planRetry({ mode: 'on', count: 0, cap: 5 }).retry, false);
  assert.equal(planRetry({ mode: 'on', count: MAX_RETRY_FILES + 1, cap: MAX_RETRY_FILES }).retry, false);
  assert.equal(planRetry({ mode: 'on', count: MAX_RETRY_FILES, cap: MAX_RETRY_FILES }).retry, true);
  assert.equal(planRetry({ mode: 'shadow', count: 1, cap: 5 }).retry, true);
});

test('a viewer retry passes only with exit 0, a full summary, a pass, and nothing failed or cancelled', () => {
  const ok = { tests: 2, pass: 2, fail: 0, cancelled: 0 };
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: ok }).passed, true);
  assert.equal(judgeViewerRetry({ exitCode: 1, summary: ok }).passed, false);
  assert.equal(judgeViewerRetry({ exitCode: null, summary: ok }).passed, false, 'killed by the timeout');
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: { ...ok, fail: 1 } }).passed, false);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: { ...ok, cancelled: 1 } }).passed, false);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: { ...ok, pass: 0 } }).passed, false, 'ran nothing');
});

test('/code-review on #9788: a viewer retry passes only if each test that failed passed again; a skip on retry is not a pass', () => {
  // Real TAP: the test that failed first now skips at runtime, its neighbour passes.
  const { tap } = realTap('retry-skips', {
    'src/a.test.ts': "import test from 'node:test';\ntest('flaky', (t) => { t.skip('not here'); });\ntest('steady', () => {});\n",
  });
  const again = parseNodeTap(tap);
  assert.equal(again.summary.fail, 0);
  const tests = [{ file: 'src/a.test.ts', title: 'flaky' }];
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: again.summary, passed: again.passed, tests }).passed, false);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: again.summary, passed: again.passed, tests: [{ file: 'src/a.test.ts', title: 'steady' }] }).passed, true);
  assert.equal(judgeViewerRetry({ exitCode: 0, summary: again.summary, passed: again.passed, tests: [{ file: 'src/a.test.ts', title: 'src/a.test.ts' }] }).passed, true, 'a file-level failure has no test title to match');
});

test('/code-review on #9788: a failure located in a file this shard does not run is not retried', () => {
  const file = 'src/hooks/useSandbox.runSupersession.test.tsx';
  const shard = assignShards([file], parseManifest(readFileSync(MANIFEST_PATH, 'utf8')), 16).get(file);
  const tap = join(TMP, 'other-shard.tap');
  writeFileSync(tap, `not ok 1 - ${file}\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# duration_ms 1\n`);
  const r = cli('viewer', { CI_SHARD_RETRY: 'on', TAP_FILE: tap, TEST_SHARDS: '16', TEST_SHARD: String((shard + 1) % 16) });
  assert.equal(r.record.plan.retry, false);
  assert.match(r.record.plan.reason, /this shard does not run/); // @source-text-assertion-ok subject is the plan's reason
});

test('titles reach the summary table and annotations on one line', () => {
  assert.equal(oneLine('a\r\nb\nc'), 'a b c');
});

test('only a `failed` Playwright run is retried; a hang or a timeout is not', () => {
  assert.deepEqual(readLastRun('{"status":"failed","failedTests":["a","a","b"]}'), { ids: ['a', 'b'] });
  assert.ok(readLastRun('{"status":"interrupted","failedTests":["a"]}').refusal);
  assert.ok(readLastRun('{"status":"timedout","failedTests":["a"]}').refusal);
  assert.ok(readLastRun('{"status":"failed"}').refusal);
  assert.ok(readLastRun('not json').refusal);
});

const PLAYWRIGHT = join(REPO_ROOT, 'node_modules/.bin/playwright');
const SPEC = `import { test } from '@playwright/test';
test.beforeAll(async () => { if (!process.env.BEFORE_ALL_PASSES) throw new Error('flaky beforeAll'); });
test('t1', () => {});
test('t2', () => {});
test('t3', () => {});
test.skip('declared skip', () => {});
test('runtime skip', () => { test.skip(true, 'not on this runner'); });
`;

/** Run a real Playwright over SPEC (no browser: no test uses `page`); return its JSON report and .last-run.json. */
function realPlaywright(name, env = {}) {
  const dir = join(TMP, name);
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'playwright.config.mjs'), "export default { testDir: './tests', workers: 1, reporter: 'json' };\n");
  writeFileSync(join(dir, 'tests/a.spec.mjs'), SPEC);
  writeFileSync(join(dir, 'tests/b.spec.mjs'), "import { test } from '@playwright/test';\ntest('b1', () => {});\n");
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  const json = join(dir, 'report.json');
  const { NODE_TEST_CONTEXT: _ignored, ...base } = process.env;
  const r = spawnSync(PLAYWRIGHT, ['test', '-c', 'playwright.config.mjs'], { cwd: dir, encoding: 'utf8', env: { ...base, PLAYWRIGHT_JSON_OUTPUT_FILE: json, ...env } });
  return { status: r.status, report: JSON.parse(readFileSync(json, 'utf8')), lastRun: readFileSync(join(dir, 'test-results/.last-run.json'), 'utf8') };
}

/** The failing-beforeAll run, shared by the tests that read it (one Playwright run, not two). */
let firstAttempt;
const beforeAllFails = () => (firstAttempt ??= realPlaywright('before-all-fails'));

const byTitle = (report) => new Map([...indexPlaywrightReport(report)].map(([id, t]) => [t.title, id]));

test('#9788 review: a failing beforeAll — the mass-skipped tests are in the failed list, and a retry plan that drops them is refused', () => {
  const first = beforeAllFails();
  assert.equal(first.status, 1);
  const ids = byTitle(first.report);
  const { ids: failed, refusal } = readLastRun(first.lastRun);
  assert.equal(refusal, undefined);
  // On the locked Playwright 1.64.1 `.last-run.json` already lists the tests
  // the hook failure skipped (`didNotRun`), runtime-skip test included.
  assert.deepEqual(new Set(failed), new Set(['t1', 't2', 't3', 'runtime skip'].map((t) => ids.get(t))));
  assert.deepEqual(new Set(unintendedSkips(indexPlaywrightReport(first.report))), new Set(['t2', 't3', 'runtime skip'].map((t) => ids.get(t))));
  assert.equal(incompleteE2eAttempt({ ids: failed, index: indexPlaywrightReport(first.report) }), null);
  // The reviewer's case: only the test that failed is listed. Refused.
  assert.match(incompleteE2eAttempt({ ids: [ids.get('t1')], index: indexPlaywrightReport(first.report) }) ?? '', /skipped without asking/); // @source-text-assertion-ok subject is the returned refusal
  assert.match(incompleteE2eAttempt({ ids: failed, index: null }) ?? '', /missing or unreadable/); // @source-text-assertion-ok subject is the returned refusal
});

test('#9788 review: a retry passes only when every retried test really passed; a deliberate skip is neither unintended nor a pass', () => {
  const first = beforeAllFails();
  const { ids: failed } = readLastRun(first.lastRun);
  const retry = realPlaywright('before-all-retry', { BEFORE_ALL_PASSES: '1' });
  assert.equal(retry.status, 0);
  assert.deepEqual(unintendedSkips(indexPlaywrightReport(retry.report)), [], 'declared and runtime skips are asked for');
  const ids = byTitle(retry.report);
  // `runtime skip` was in the failed list and now skips on purpose: not a pass, so the retry is red.
  assert.equal(judgeE2eRetry({ exitCode: 0, ids: failed, report: retry.report }).passed, false);
  const ran = ['t1', 't2', 't3'].map((t) => ids.get(t));
  assert.equal(judgeE2eRetry({ exitCode: 0, ids: ran, report: retry.report }).passed, true);
  assert.equal(judgeE2eRetry({ exitCode: 1, ids: ran, report: retry.report }).passed, false);
  assert.equal(judgeE2eRetry({ exitCode: 0, ids: [...ran, 'not-a-test-id'], report: retry.report }).passed, false, '--shard turns "No tests found" into exit 0');
  assert.equal(judgeE2eRetry({ exitCode: 0, ids: ran, report: null }).passed, false);
});

// --------------------------------------------------- the CLI's refusals

function cli(kind, env) {
  const dir = mkdtempSync(join(TMP, 'cli-'));
  const summary = join(dir, 'summary.md');
  // One shard holding every path, unless a test names a real one.
  const code = run([kind], { REPORT_DIR: join(dir, 'out'), GITHUB_STEP_SUMMARY: summary, TEST_SHARDS: '1', TEST_SHARD: '0', ...env });
  const record = JSON.parse(readFileSync(join(dir, 'out', `${kind}-retry.json`), 'utf8'));
  return { code, record, summary: readFileSync(summary, 'utf8') };
}

test('the CLI exits 1 without retrying when the first attempt cannot be read or attributed', () => {
  const missing = cli('viewer', { CI_SHARD_RETRY: 'on', TEST_SHARD: '3', TAP_FILE: join(TMP, 'absent.tap') });
  assert.equal(missing.code, 1);
  assert.equal(missing.record.plan.retry, false);
  assert.equal(missing.record.passed, false);
  assert.ok(missing.summary.length > 0);

  const cut = join(TMP, 'cut.tap');
  writeFileSync(cut, 'TAP version 13\nnot ok 1 - src/a.test.ts\n');
  const cutOff = cli('viewer', { CI_SHARD_RETRY: 'on', TAP_FILE: cut });
  assert.equal(cutOff.code, 1);
  assert.equal(cutOff.record.plan.retry, false, 'no closing summary: not retried');

  const tap = join(TMP, 'unattributed.tap');
  writeFileSync(tap, 'TAP version 13\nnot ok 1 - something global\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# duration_ms 1\n');
  assert.equal(cli('viewer', { CI_SHARD_RETRY: 'on', TAP_FILE: tap }).code, 1);

  const many = join(TMP, 'many.tap');
  const n = MAX_RETRY_FILES + 1;
  writeFileSync(many, `${Array.from({ length: n }, (_, i) => `not ok ${i + 1} - src/f${i}.test.ts`).join('\n')}\n# tests ${n}\n# pass 0\n# fail ${n}\n# cancelled 0\n# duration_ms 1\n`);
  const tooMany = cli('viewer', { CI_SHARD_RETRY: 'on', TAP_FILE: many });
  assert.equal(tooMany.code, 1);
  assert.equal(tooMany.record.files.length, MAX_RETRY_FILES + 1);
  assert.equal(tooMany.record.plan.retry, false);
  assert.match(tooMany.record.plan.reason, /more than/); // @source-text-assertion-ok subject is the plan's reason
});

test('the CLI never retries with the switch off, even when asked directly', () => {
  const tap = join(TMP, 'one.tap');
  writeFileSync(tap, 'not ok 1 - src/one.test.ts\n');
  for (const mode of [undefined, 'off', 'yes']) assert.equal(cli('viewer', { CI_SHARD_RETRY: mode, TAP_FILE: tap }).record.plan.retry, false);
});

test('the E2E CLI refuses an interrupted first attempt', () => {
  const last = join(TMP, 'last-run.json');
  writeFileSync(last, '{"status":"interrupted","failedTests":["a"]}');
  const r = cli('e2e', { CI_SHARD_RETRY: 'on', E2E_SHARD: '3/8', LAST_RUN: last, REPORT_JSON: join(TMP, 'absent.json') });
  assert.equal(r.code, 1);
  assert.equal(r.record.plan.retry, false);
});

// ------------------------------------------------------------ the wiring

const SWITCH = /vars\.CI_SHARD_RETRY/;

for (const [job, testStep, retryStep] of [['viewer-tests', 'viewer_tests', 'viewer_retry'], ['viewer-e2e', 'e2e', 'e2e_retry']]) {
  test(`${job}: only \`on\` lets the test step fail, and a guard re-fails it unless the retry step succeeded`, () => {
    const steps = WORKFLOW.jobs[job].steps;
    const first = steps.find((s) => s.id === testStep);
    // A GitHub Actions expression, compared as written.
    // eslint-disable-next-line no-template-curly-in-string
    assert.equal(first['continue-on-error'], "${{ vars.CI_SHARD_RETRY == 'on' }}");
    const retry = steps.find((s) => s.id === retryStep);
    assert.ok(retry, 'retry step exists');
    assert.equal(retry.if, `(success() || failure()) && steps.${testStep}.outcome == 'failure' && (vars.CI_SHARD_RETRY == 'shadow' || vars.CI_SHARD_RETRY == 'on')`);
    const guard = steps.slice(steps.indexOf(retry) + 1).find((s) => s.if?.includes(`steps.${retryStep}.outcome != 'success'`)); // @source-text-assertion-ok selects a step from the parsed workflow
    assert.ok(guard, 'guard step follows the retry');
    assert.equal(guard.if, `(success() || failure()) && steps.${testStep}.outcome == 'failure' && vars.CI_SHARD_RETRY == 'on' && steps.${retryStep}.outcome != 'success'`);
    assert.match(guard.run, /exit 1/); // @source-text-assertion-ok the guard's command is the subject
    // Every other step's behaviour is independent of the switch.
    const touched = steps.filter((s) => SWITCH.test(JSON.stringify(s))).map((s) => s.id ?? s.name); // @source-text-assertion-ok enumerates steps that read the switch
    assert.deepEqual(touched.sort(), [testStep, retryStep, guard.name].sort());
  });
}
