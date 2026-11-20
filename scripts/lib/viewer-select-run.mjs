/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ci-viewer-select.mjs --run`: run the selected viewer test files, retry the
 * files that failed once (the shards' CI_SHARD_RETRY rules, reused from
 * scripts/lib/shard-retry.mjs), and write the verdict to `<dir>/result.json`.
 * The `PR viewer selection` commit status (scripts/ci-viewer-select-status.mjs)
 * is posted from that verdict.
 *
 * THE VERDICT (`passed`) follows the viewer shards exactly:
 *   - the first attempt exited 0: passed;
 *   - it failed and CI_SHARD_RETRY=on: passed only if every failed file was
 *     retried ALONE and passed, under the shards' refusals (an incomplete TAP,
 *     an unattributed failure, more than MAX_RETRY_FILES files, a failure in a
 *     file this run was not given, no time left);
 *   - `shadow` retries and records, but keeps the first attempt's verdict;
 *     `off` does not retry.
 *
 * Always exits 0 (the job is advisory to the Test run; see ci-viewer-select.mjs).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { retryBudgetMs } from '../ci-shard-retry.mjs';
import {
  MAX_RETRY_FILES,
  attributeViewerFailures,
  decideMode,
  incompleteViewerAttempt,
  judgeViewerRetry,
  parseNodeTap,
  planRetry,
} from './shard-retry.mjs';

/** Shorter retries than this are not worth starting (as ci-shard-retry.mjs). */
const MIN_RETRY_MS = 60_000;
/**
 * THE REPORTING RESERVE: the last part of the job that no test child may
 * reach, so result.json, the `PR viewer selection` verdict and the artifact
 * upload always run. Without it a hung test (first attempt or retry) ends with
 * the job killed by its own timeout and the pending status left behind.
 */
export const REPORT_RESERVE_MS = 3 * 60_000;
/** coreutils `timeout --kill-after`: a child may outlive its limit by this. */
const KILL_AFTER_S = 30;
/**
 * Job time the first attempt leaves unused beyond the reserve's share: room
 * for a retry. Dropped when the job is too far gone to keep it.
 */
const FIRST_RESERVE_MS = 5 * 60_000;
/** The first attempt's cap when the job start or limit is unknown. */
const FIRST_FALLBACK_S = 12 * 60;

function jobEndMs(env) {
  const started = Number(env.JOB_STARTED_AT) * 1000;
  const limit = Number(env.JOB_TIMEOUT_MINUTES) * 60_000;
  return started > 0 && limit > 0 ? started + limit : null;
}

/**
 * Whole seconds a test child may be given: at most `capMs`, and, when the
 * job's end is known, ending (kill-after included) before the reporting
 * reserve. 0 means "do not start it".
 */
export function childSeconds(env, capMs, now = Date.now()) {
  const end = jobEndMs(env);
  const room = end === null ? capMs : Math.min(capMs, end - REPORT_RESERVE_MS - KILL_AFTER_S * 1000 - now);
  return room >= 1000 ? Math.floor(room / 1000) : 0;
}

/**
 * Seconds the first attempt may run: what is left of the job minus
 * FIRST_RESERVE_MS while at least a minute of that remains, else whatever
 * fits before the reporting reserve (0: not started); FIRST_FALLBACK_S when
 * the job's end is unknown.
 */
export function firstAttemptSeconds(env, now = Date.now()) {
  const end = jobEndMs(env);
  if (end === null) return FIRST_FALLBACK_S;
  const withRetryRoom = end - FIRST_RESERVE_MS - now;
  return childSeconds(env, withRetryRoom >= 60_000 ? withRetryRoom : Infinity, now);
}

/** coreutils `timeout`: 124 when it fired, 137 when --kill-after had to SIGKILL. */
const timedOutExit = (code) => code === 124 || code === 137;

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** NODE_OPTIONS plus one more TAP reporter writing to `file`. */
export function withTapReporter(nodeOptions, file) {
  return `${nodeOptions ? `${nodeOptions} ` : ''}--test-reporter=tap --test-reporter-destination=${file}`;
}

/**
 * Whether and what to retry after a failed first attempt.
 * @param {{ mode: string, tap: string|null, viewerRoot: string, files: string[], budgetMs: number|null }} input
 */
export function planSelectedRetry({ mode, tap, viewerRoot, files, budgetMs }) {
  const first = tap === null ? null : parseNodeTap(tap);
  const attributed = first ? attributeViewerFailures(first.failures, viewerRoot) : { files: [], tests: [], unattributed: [] };
  const given = new Set(files);
  const outside = attributed.files.filter((f) => !given.has(f));
  let plan = planRetry({
    mode,
    count: attributed.files.length,
    cap: MAX_RETRY_FILES,
    unattributed: attributed.unattributed,
    refusal: tap === null
      ? 'the first attempt left no TAP file'
      : incompleteViewerAttempt(first) ?? (outside.length > 0 ? `failure(s) located in file(s) this run was not given: ${outside.join(', ')}` : undefined),
  });
  if (plan.retry && budgetMs === null) plan = { retry: false, reason: 'JOB_STARTED_AT or JOB_TIMEOUT_MINUTES is not set, so the job time left is unknown' };
  else if (plan.retry && budgetMs < MIN_RETRY_MS) plan = { retry: false, reason: `only ${Math.max(0, Math.round(budgetMs / 1000))} s of the job's time is left for a retry` };
  return { plan, files: attributed.files, tests: attributed.tests };
}

/**
 * The verdict of a run: the first exit code, plus the retry when it counts.
 * `failedFiles` is what the commit status names.
 */
export function verdict({ exitCode, mode, retry }) {
  if (exitCode === 0) return { passed: true, failedFiles: [] };
  const retried = retry?.plan?.retry === true && retry.result?.passed === true;
  if (mode === 'on' && retried) return { passed: true, failedFiles: [], passedOnRetry: retry.files };
  // In `on`, a file that passed its own retry is not a failure even when
  // another file failed again (its flake is still reported); a file never
  // retried (the loop stops at the first file that fails again) is. `shadow`
  // keeps the first attempt's verdict, files included. An unattributed
  // failure names no file.
  const recovered = new Set(mode === 'on' ? (retry?.results ?? []).filter((x) => x.passed).map((x) => x.file) : []);
  const failedFiles = (retry?.files ?? []).filter((f) => !recovered.has(f));
  return { passed: false, failedFiles, ...(recovered.size > 0 ? { passedOnRetry: [...recovered] } : {}) };
}

/**
 * @param {{ root: string, viewer: string, dir: string, env: NodeJS.ProcessEnv, runner: string[] }} input
 *   `runner` is the tsx argv from the viewer `test` script (runnerArgs).
 */
export function runSelectedTests({ root, viewer, dir: given, env, runner }) {
  // Absolute: the TAP destinations are opened by a child running in apps/viewer.
  const dir = resolve(given);
  const files = readFileSync(join(dir, 'files.txt'), 'utf8').split('\n').filter(Boolean);
  if (files.length === 0) throw new Error('files.txt is empty; tsx would fall back to its default glob');
  const cwd = join(root, viewer);
  const [bin, ...args] = runner;
  const { mode, warning } = decideMode(env.CI_SHARD_RETRY);
  if (warning) console.log(`::warning::${warning}`);

  const firstTap = join(dir, 'attempt1.tap');
  // Under `timeout` (process group, as the retry), so a hung test cannot eat the job.
  const firstSeconds = firstAttemptSeconds(env);
  const notStarted = firstSeconds === 0;
  let r = { status: 124, signal: null };
  if (notStarted) {
    // The reporting reserve is all that is left: report, do not test.
    console.log('::warning title=Selected viewer tests::no job time left before the reporting reserve; the tests were not started');
  } else {
    r = spawnSync('timeout', [`--kill-after=${KILL_AFTER_S}s`, `${firstSeconds}s`, 'pnpm', 'exec', bin, ...args, ...files], {
      cwd, stdio: 'inherit', env: { ...env, NODE_OPTIONS: withTapReporter(env.NODE_OPTIONS, firstTap) },
    });
    if (r.error) throw r.error;
  }
  const exitCode = r.status ?? 1;

  let retry = null;
  // Parsed in every mode, so the status can name the failing files; `off` never retries.
  if (exitCode !== 0 && !notStarted) {
    const budgetMs = retryBudgetMs(env);
    let viewerRoot = cwd;
    try {
      viewerRoot = realpathSync(cwd);
    } catch { /* keep cwd; attribution then refuses */ }
    retry = planSelectedRetry({ mode, tap: readOptional(firstTap), viewerRoot, files, budgetMs });
    if (retry.plan.retry) {
      const deadline = Date.now() + budgetMs;
      const results = [];
      for (const [i, file] of retry.files.entries()) {
        // Within the shared retry budget AND before the reporting reserve.
        const left = childSeconds(env, deadline - Date.now());
        if (left < 1) {
          results.push({ file, passed: false, reason: 'the shared retry budget ran out before this file' });
          break;
        }
        const tap = join(dir, `retry-${i}.tap`);
        console.log(`[ci-viewer-select] rerunning ${file}`);
        // coreutils `timeout` signals the whole process group (see ci-shard-retry.mjs).
        const again = spawnSync('timeout', [`--kill-after=${KILL_AFTER_S}s`, `${left}s`, 'pnpm', 'exec', bin, ...args, file], {
          cwd, stdio: 'inherit', env: { ...env, NODE_OPTIONS: withTapReporter(env.NODE_OPTIONS, tap) },
        });
        const text = readOptional(tap);
        const parsed = text === null ? null : parseNodeTap(text);
        const v = judgeViewerRetry({ exitCode: again.status, summary: parsed?.summary ?? null, passed: parsed?.passed, tests: retry.tests.filter((t) => t.file === file) });
        results.push({ file, ...v });
        if (mode === 'on' && !v.passed) break;
      }
      const failed = results.filter((x) => !x.passed);
      retry.results = results;
      retry.result = failed.length === 0
        ? { passed: true, reason: `all ${results.length} file(s) passed on retry` }
        : { passed: false, reason: failed.map((x) => `${x.file}: ${x.reason}`).join('; ') };
    }
    console.log(`[ci-viewer-select] retry (${mode}): ${retry.plan.reason}${retry.result ? `; ${retry.result.reason}` : ''}`);
  }

  const v = verdict({ exitCode, mode, retry });
  const timedOut = !v.passed && timedOutExit(exitCode);
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ files: files.length, exitCode, signal: r.signal ?? null, timedOut, notStarted, retry, ...v })}\n`);
  const summary = (lines) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (!v.passed) {
    const msg = `${files.length} selected viewer test file(s) ran and at least one failed (exit ${exitCode}). The \`PR viewer selection\` status blocks queue entry; see the log above.`;
    console.log(`::warning title=Selected viewer tests::${msg}`);
    for (const f of v.passedOnRetry ?? []) console.log(`::warning title=Flaky test (selected viewer tests)::${f} needed a retry`);
    summary(['', `**${msg}**`]);
  } else if (v.passedOnRetry) {
    for (const f of v.passedOnRetry) console.log(`::warning title=Flaky test (selected viewer tests)::${f} needed a retry`);
    summary(['', `${files.length} selected viewer test file(s) passed; ${v.passedOnRetry.length} needed a retry.`]);
  } else {
    summary(['', `${files.length} selected viewer test file(s) passed.`]);
  }
  return 0;
}
