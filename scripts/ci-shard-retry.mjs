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
  parseNodeTap,
  planRetry,
  readLastRun,
  summaryLines,
  viewerPattern,
} from './lib/shard-retry.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER_ROOT = join(REPO_ROOT, 'apps/viewer');
/** Inside the workspace, where test.yml's `hashFiles` can see it. */
export const RETRY_JUNIT = join(VIEWER_ROOT, 'mergify-junit-retry.xml');

/** Leaves room in the 25-minute viewer job and the 20-minute E2E job. */
const VIEWER_RETRY_TIMEOUT_MS = 8 * 60_000;
const E2E_RETRY_TIMEOUT = '4m';

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function retryViewer(env, mode, reportDir) {
  const tap = readOptional(resolve(VIEWER_ROOT, required(env, 'TAP_FILE')));
  const first = tap === null ? null : parseNodeTap(tap);
  const attributed = first ? attributeViewerFailures(first.failures, realpathSync(VIEWER_ROOT)) : { files: [], tests: [], unattributed: [] };
  const plan = planRetry({
    mode,
    count: attributed.files.length,
    cap: MAX_RETRY_FILES,
    unattributed: attributed.unattributed,
    refusal: tap === null ? 'the first attempt left no TAP file' : incompleteViewerAttempt(first) ?? undefined,
  });
  const record = { kind: 'viewer', shard: env.TEST_SHARD ?? '?', mode, plan, files: attributed.files, tests: attributed.tests };
  if (!plan.retry) return record;

  const retryTap = join(reportDir, 'viewer-retry.tap');
  console.log(`[ci-shard-retry] rerunning ${attributed.files.length} file(s): ${attributed.files.join(' ')}`);
  const r = spawnSync('pnpm', ['--filter', '@ifc-lite/viewer', 'run', 'test'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    timeout: VIEWER_RETRY_TIMEOUT_MS,
    env: {
      ...env,
      TEST_PATTERN: viewerPattern(attributed.files),
      // The JUnit goes to Mergify like the first attempt's, so a test that
      // failed then passed on one SHA reads there as flaky, not broken.
      NODE_OPTIONS: `--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=${retryTap} --test-reporter=junit --test-reporter-destination=${RETRY_JUNIT}`,
    },
  });
  const retried = readOptional(retryTap);
  record.result = judgeViewerRetry({ exitCode: r.status, summary: retried === null ? null : parseNodeTap(retried).summary });
  return record;
}

function retryE2e(env, mode, reportDir) {
  const last = readOptional(required(env, 'LAST_RUN'));
  const { ids, refusal } = last === null ? { ids: [], refusal: 'the first attempt left no .last-run.json' } : readLastRun(last);
  let firstReport = null;
  try {
    const text = readOptional(required(env, 'REPORT_JSON'));
    firstReport = text === null ? null : JSON.parse(text);
  } catch (err) {
    console.log(`::warning::first attempt's JSON report is unreadable (${err.message})`);
  }
  const index = firstReport ? indexPlaywrightReport(firstReport) : new Map();
  const tests = ids.map((id) => {
    const t = index.get(id);
    return t ? { file: `${t.file}:${t.line}`, title: t.title } : { file: '?', title: `test id ${id}` };
  });
  const plan = planRetry({ mode, count: ids.length, cap: MAX_RETRY_TESTS, refusal: refusal ?? incompleteE2eAttempt({ ids, report: firstReport }) ?? undefined });
  const shard = required(env, 'E2E_SHARD');
  const record = { kind: 'e2e', shard, mode, plan, ids, tests };
  if (!plan.retry) return record;

  // The retry reads, and then overwrites, a COPY: test-results/.last-run.json
  // stays the first attempt's. `--output` keeps the first attempt's traces in
  // test-results/ for the failure-context upload. `--shard` is kept because
  // Playwright applies the last-failed filter AFTER sharding, so the ids
  // resolve exactly as they did in the first attempt.
  const lastFailedFile = join(reportDir, 'e2e-retry-last-run.json');
  copyFileSync(required(env, 'LAST_RUN'), lastFailedFile);
  const retryJson = join(reportDir, 'e2e-retry-report.json');
  console.log(`[ci-shard-retry] rerunning ${ids.length} test(s): ${tests.map((t) => t.title).join('; ')}`);
  const r = spawnSync('timeout', [
    '--signal=INT', '--kill-after=30s', E2E_RETRY_TIMEOUT,
    'pnpm', 'test:e2e:ci', `--shard=${shard}`, '--reporter=list,@mergifyio/playwright,json',
    '--last-failed', `--last-failed-file=${lastFailedFile}`, '--output=test-results/retry',
  ], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: retryJson } });
  let report = null;
  try {
    const text = readOptional(retryJson);
    report = text === null ? null : JSON.parse(text);
  } catch (err) {
    console.log(`::warning::retry JSON report is unreadable: ${err.message}`);
  }
  record.result = judgeE2eRetry({ exitCode: r.status, ids, report });
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
  writeFileSync(join(reportDir, `${kind}-retry.json`), `${JSON.stringify({ ...record, passed }, null, 2)}\n`);
  const lines = summaryLines(record);
  for (const l of lines) console.log(l);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (passed) {
    const verb = mode === 'on' ? 'needed a retry' : 'would have passed on retry';
    for (const t of record.tests) console.log(`::warning title=Flaky test (${kind} shard ${record.shard})::${t.file} › ${t.title} ${verb}`);
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
