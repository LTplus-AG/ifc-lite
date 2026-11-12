#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retry a failed viewer test shard or viewer E2E shard ONCE, inside the same
 * job, rerunning only what failed.
 *
 * WHY IN THE JOB. Mergify dequeues a batch the moment the aggregate goes red,
 * so a workflow-level rerun comes too late: the batch and everything stacked
 * behind it has already been reset. Of 86 failed queue batches in one week, 79
 * had every PR merge later; several single-PR batches failed only in one E2E
 * shard and merged later with the same head.
 *
 * THE SWITCH is the repo variable `CI_SHARD_RETRY`:
 *   unset / `off`  today's behaviour. The retry steps in test.yml are skipped
 *                  and the test steps run exactly as before.
 *   `shadow`       the retry runs and is reported (job summary + artifact),
 *                  but the job keeps the FIRST attempt's verdict. For
 *                  measuring the flake rate before turning it on.
 *   `on`           the first attempt is `continue-on-error`, and this step's
 *                  exit code is the verdict: 0 only when the retry ran and
 *                  passed. The summary and a warning annotation name every
 *                  test that needed it.
 * Any other value is `off` (test.yml compares with `==`, so it never reaches
 * a retry step).
 *
 * FAIL CLOSED. This script exits 0 only on positive evidence that every
 * failed test ran again and passed. An unreadable report, a failure it cannot
 * tie to a file or test id, more than MAX_RETRY_* failures, a first attempt
 * that hung or timed out, a retry that ran nothing, or a crash here all exit
 * 1. Never more than one retry: this script does not loop.
 *
 *   node scripts/ci-shard-retry.mjs viewer
 *     CI_SHARD_RETRY, TEST_SHARDS, TEST_SHARD (as the test step), TAP_FILE
 *     (the first attempt's TAP, relative to apps/viewer), REPORT_DIR
 *   node scripts/ci-shard-retry.mjs e2e
 *     CI_SHARD_RETRY, E2E_SHARD (`n/8`), LAST_RUN (the first attempt's
 *     test-results/.last-run.json), REPORT_JSON (its JSON report), REPORT_DIR
 *
 * Writes `<REPORT_DIR>/<kind>-retry.json` and appends to GITHUB_STEP_SUMMARY.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from './lib/is-main-entry.mjs';
import { MANIFEST_PATH, assignShards, parseManifest, shardFromEnv } from './viewer-test-shards.mjs';
import {
  MAX_RETRY_FILES,
  MAX_RETRY_TESTS,
  attributeViewerFailures,
  decideMode,
  incompleteE2eAttempt,
  incompleteViewerAttempt,
  indexPlaywrightReport,
  judgeE2eRetry,
  judgeViewerRetry,
  oneLine,
  parseNodeTap,
  planRetry,
  readLastRun,
  retryCount,
  summaryLines,
  viewerPattern,
} from './lib/shard-retry.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER_ROOT = join(REPO_ROOT, 'apps/viewer');
/** Inside the workspace, where test.yml's `hashFiles` can see them. */
const retryJunit = (i) => join(VIEWER_ROOT, `mergify-junit-retry-${i}.xml`);

/** The most a retry may take, before the job's own limit cuts it shorter. */
const RETRY_CAP_MS = 8 * 60_000;
/** Job time kept back for the uploads after the retry (failure context, records). */
const RESERVE_MS = 3 * 60_000;
/** Less than this left is not worth starting a retry for. */
const MIN_RETRY_MS = 60_000;

/**
 * The retry's time budget. The jobs keep today's limits in every mode, so the
 * retry gets what is left of the job (JOB_STARTED_AT, JOB_TIMEOUT_MINUTES from
 * test.yml) minus a reserve for the uploads after it, capped at RETRY_CAP_MS.
 * Unknown start or limit: null, and no retry.
 */
export function retryBudgetMs(env, now = Date.now()) {
  const started = Number(env.JOB_STARTED_AT) * 1000;
  const limit = Number(env.JOB_TIMEOUT_MINUTES) * 60_000;
  if (!(started > 0) || !(limit > 0)) return null;
  return Math.min(RETRY_CAP_MS, started + limit - RESERVE_MS - now);
}

/** Turn a planned retry into a refusal when the job has no time left for it. */
function withinBudget(plan, budget) {
  if (!plan.retry) return plan;
  if (budget === null) return { retry: false, reason: 'JOB_STARTED_AT or JOB_TIMEOUT_MINUTES is not set, so the job time left is unknown' };
  if (budget >= MIN_RETRY_MS) return plan;
  return { retry: false, reason: `only ${Math.max(0, Math.round(budget / 1000))} s of the job's time is left for a retry` };
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Parsed JSON, or null when the file is missing or unreadable (logged). */
function readJsonOptional(path, label) {
  try {
    const text = readOptional(path);
    return text === null ? null : JSON.parse(text);
  } catch (err) {
    console.log(`::warning::${label} is unreadable (${err.message})`);
    return null;
  }
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * A failure located in a file this shard does not run (a test registered from
 * another file) would be retried by a pattern the shard filter then empties
 * or narrows. Refuse it rather than let the other files' pass stand for it.
 */
function notInShard(files, env) {
  let shard;
  let count;
  try {
    ({ shard, count } = shardFromEnv(env));
  } catch (err) {
    return `cannot read this shard: ${err.message}`;
  }
  const assigned = assignShards(files, parseManifest(readFileSync(MANIFEST_PATH, 'utf8')), count);
  const outside = files.filter((f) => assigned.get(f) !== shard);
  return outside.length > 0 ? `failure(s) located in file(s) this shard does not run: ${outside.join(', ')}` : null;
}

function retryViewer(env, mode, reportDir) {
  const tap = readOptional(resolve(VIEWER_ROOT, required(env, 'TAP_FILE')));
  const first = tap === null ? null : parseNodeTap(tap);
  const attributed = first ? attributeViewerFailures(first.failures, realpathSync(VIEWER_ROOT)) : { files: [], tests: [], unattributed: [] };
  const budget = retryBudgetMs(env);
  const plan = withinBudget(planRetry({
    mode,
    count: attributed.files.length,
    cap: MAX_RETRY_FILES,
    unattributed: attributed.unattributed,
    refusal: tap === null ? 'the first attempt left no TAP file' : incompleteViewerAttempt(first) ?? notInShard(attributed.files, env) ?? undefined,
  }), budget);
  const record = { kind: 'viewer', shard: env.TEST_SHARD ?? '?', mode, plan, files: attributed.files, tests: attributed.tests };
  if (!plan.retry) return record;

  // One run per file, so each file's failures are matched only against that
  // file's results: a same-titled test elsewhere cannot stand in. The runs
  // share one budget, so five files take no longer than one retry did.
  const deadline = Date.now() + budget;
  // In `on` the first file that fails again decides the shard, so stop there;
  // `shadow` runs every file for the measurement.
  const results = [];
  for (const [i, file] of attributed.files.entries()) {
    if (mode === 'on' && results.some((x) => !x.passed)) break;
    results.push(retryOneFile(file, i));
  }
  function retryOneFile(file, i) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (left < 1) return { file, passed: false, reason: 'the shared retry budget ran out before this file' };
    const retryTap = join(reportDir, `viewer-retry-${i}.tap`);
    console.log(`[ci-shard-retry] rerunning ${file}`);
    // coreutils `timeout`, not spawnSync's: it signals the whole process
    // group, so the tsx/node children die with pnpm instead of outliving it.
    const r = spawnSync('timeout', ['--kill-after=30s', `${left}s`, 'pnpm', '--filter', '@ifc-lite/viewer', 'run', 'test'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...env,
        TEST_PATTERN: viewerPattern([file]),
        // JUnit for Mergify, uploaded in `on` only (test.yml).
        NODE_OPTIONS: `--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=${retryTap} --test-reporter=junit --test-reporter-destination=${retryJunit(i)}`,
      },
    });
    const retried = readOptional(retryTap);
    const again = retried === null ? null : parseNodeTap(retried);
    const verdict = judgeViewerRetry({ exitCode: r.status, summary: again?.summary ?? null, passed: again?.passed, tests: attributed.tests.filter((t) => t.file === file) });
    return { file, ...verdict };
  }
  const failed = results.filter((x) => !x.passed);
  record.result = failed.length === 0
    ? { passed: true, reason: `all ${results.length} file(s) passed on retry` }
    : { passed: false, reason: failed.map((x) => `${x.file}: ${x.reason}`).join('; ') };
  return record;
}

/** The E2E retry's command and environment; only `on` reports the retry to Mergify. */
export function e2eRetryCommand({ mode, shard, lastFailedFile, env, budgetMs }) {
  const reporters = mode === 'on' ? 'list,@mergifyio/playwright,json' : 'list,json';
  // `--reporter` replaces the config's list, withMergify's entry included.
  const { MERGIFY_TOKEN: _token, ...rest } = env;
  return {
    args: [
      '--signal=INT', '--kill-after=30s', `${Math.floor(budgetMs / 1000)}s`,
      'pnpm', 'test:e2e:ci', `--shard=${shard}`, `--reporter=${reporters}`,
      '--last-failed', `--last-failed-file=${lastFailedFile}`, '--output=test-results/retry',
    ],
    env: mode === 'on' ? env : rest,
  };
}

function retryE2e(env, mode, reportDir) {
  const lastRun = required(env, 'LAST_RUN');
  const shard = required(env, 'E2E_SHARD');
  const last = readOptional(lastRun);
  const { ids, refusal } = last === null ? { ids: [], refusal: 'the first attempt left no .last-run.json' } : readLastRun(last);
  const firstReport = readJsonOptional(required(env, 'REPORT_JSON'), "the first attempt's JSON report");
  const index = firstReport ? indexPlaywrightReport(firstReport) : null;
  const tests = ids.map((id) => {
    const t = index?.get(id);
    return t ? { file: `${t.file}:${t.line}`, title: t.title, didNotRun: t.status === 'skipped' } : { file: '?', title: `test id ${id}` };
  });
  const budget = retryBudgetMs(env);
  const plan = withinBudget(planRetry({ mode, count: retryCount(ids, index), cap: MAX_RETRY_TESTS, refusal: refusal ?? incompleteE2eAttempt({ ids, index }) ?? undefined }), budget);
  const record = { kind: 'e2e', shard, mode, plan, ids, tests };
  if (!plan.retry) return record;

  // The retry reads, and then overwrites, a COPY: test-results/.last-run.json
  // stays the first attempt's. `--output` keeps the first attempt's traces in
  // test-results/ for the failure-context upload. `--shard` is kept because
  // Playwright applies the last-failed filter AFTER sharding, so the ids
  // resolve exactly as they did in the first attempt.
  const lastFailedFile = join(reportDir, 'e2e-retry-last-run.json');
  copyFileSync(lastRun, lastFailedFile);
  const retryJson = join(reportDir, 'e2e-retry-report.json');
  console.log(`[ci-shard-retry] rerunning ${ids.length} test(s): ${tests.map((t) => t.title).join('; ')}`);
  const cmd = e2eRetryCommand({ mode, shard, lastFailedFile, env, budgetMs: budget });
  const r = spawnSync('timeout', cmd.args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...cmd.env, PLAYWRIGHT_JSON_OUTPUT_FILE: retryJson } });
  record.result = judgeE2eRetry({ exitCode: r.status, ids, report: readJsonOptional(retryJson, "the retry's JSON report"), first: index });
  return record;
}

export function run(argv, env = process.env) {
  const kind = argv[0];
  if (kind !== 'viewer' && kind !== 'e2e') throw new Error('usage: ci-shard-retry.mjs viewer|e2e');
  const { mode, warning } = decideMode(env.CI_SHARD_RETRY);
  if (warning) console.log(`::warning::${warning}`);
  const reportDir = resolve(required(env, 'REPORT_DIR'));
  mkdirSync(reportDir, { recursive: true });

  const record = kind === 'viewer' ? retryViewer(env, mode, reportDir) : retryE2e(env, mode, reportDir);
  const passed = record.plan.retry && record.result?.passed === true;
  const outcome = { ...record, passed };
  writeFileSync(join(reportDir, `${kind}-retry.json`), `${JSON.stringify(outcome, null, 2)}\n`);
  const lines = summaryLines(outcome);
  for (const l of lines) console.log(l);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (passed) {
    const verb = mode === 'on' ? 'needed a retry' : 'would have passed on retry';
    // Workflow-command escaping: %, CR and LF in the message.
    const esc = (v) => oneLine(v).replace(/%/g, '%25');
    // Only tests that failed: one an earlier failure merely skipped is not flaky.
    for (const t of record.tests.filter((x) => !x.didNotRun)) console.log(`::warning title=Flaky test (${kind} shard ${record.shard})::${esc(t.file)} › ${esc(t.title)} ${verb}`);
  }
  return passed ? 0 : 1;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-shard-retry] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
