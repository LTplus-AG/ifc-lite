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
import { join } from 'node:path';

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
  // An unattributed failure names no file; the status then says so.
  return { passed: false, failedFiles: retry?.files ?? [] };
}

/**
 * @param {{ root: string, viewer: string, dir: string, env: NodeJS.ProcessEnv, runner: string[] }} input
 *   `runner` is the tsx argv from the viewer `test` script (runnerArgs).
 */
export function runSelectedTests({ root, viewer, dir, env, runner }) {
  const files = readFileSync(join(dir, 'files.txt'), 'utf8').split('\n').filter(Boolean);
  if (files.length === 0) throw new Error('files.txt is empty; tsx would fall back to its default glob');
  const cwd = join(root, viewer);
  const [bin, ...args] = runner;
  const { mode, warning } = decideMode(env.CI_SHARD_RETRY);
  if (warning) console.log(`::warning::${warning}`);

  const firstTap = join(dir, 'attempt1.tap');
  const r = spawnSync('pnpm', ['exec', bin, ...args, ...files], {
    cwd, stdio: 'inherit', env: { ...env, NODE_OPTIONS: withTapReporter(env.NODE_OPTIONS, firstTap) },
  });
  if (r.error) throw r.error;
  const exitCode = r.status ?? 1;

  let retry = null;
  // Parsed in every mode, so the status can name the failing files; `off` never retries.
  if (exitCode !== 0) {
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
        const left = Math.floor((deadline - Date.now()) / 1000);
        if (left < 1) {
          results.push({ file, passed: false, reason: 'the shared retry budget ran out before this file' });
          break;
        }
        const tap = join(dir, `retry-${i}.tap`);
        console.log(`[ci-viewer-select] rerunning ${file}`);
        // coreutils `timeout` signals the whole process group (see ci-shard-retry.mjs).
        const again = spawnSync('timeout', ['--kill-after=30s', `${left}s`, 'pnpm', 'exec', bin, ...args, file], {
          cwd, stdio: 'inherit', env: { ...env, NODE_OPTIONS: withTapReporter(env.NODE_OPTIONS, tap) },
        });
        const text = readOptional(tap);
        const parsed = text === null ? null : parseNodeTap(text);
        const v = judgeViewerRetry({ exitCode: again.status, summary: parsed?.summary ?? null, passed: parsed?.passed, tests: retry.tests.filter((t) => t.file === file) });
        results.push({ file, ...v });
        if (mode === 'on' && !v.passed) break;
      }
      const failed = results.filter((x) => !x.passed);
      retry.result = failed.length === 0
        ? { passed: true, reason: `all ${results.length} file(s) passed on retry` }
        : { passed: false, reason: failed.map((x) => `${x.file}: ${x.reason}`).join('; ') };
    }
    console.log(`[ci-viewer-select] retry (${mode}): ${retry.plan.reason}${retry.result ? `; ${retry.result.reason}` : ''}`);
  }

  const v = verdict({ exitCode, mode, retry });
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ files: files.length, exitCode, signal: r.signal ?? null, retry, ...v })}\n`);
  const summary = (lines) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (!v.passed) {
    const msg = `${files.length} selected viewer test file(s) ran and at least one failed (exit ${exitCode}). The \`PR viewer selection\` status blocks queue entry; see the log above.`;
    console.log(`::warning title=Selected viewer tests::${msg}`);
    summary(['', `**${msg}**`]);
  } else if (v.passedOnRetry) {
    for (const f of v.passedOnRetry) console.log(`::warning title=Flaky test (selected viewer tests)::${f} needed a retry`);
    summary(['', `${files.length} selected viewer test file(s) passed; ${v.passedOnRetry.length} needed a retry.`]);
  } else {
    summary(['', `${files.length} selected viewer test file(s) passed.`]);
  }
  return 0;
}
