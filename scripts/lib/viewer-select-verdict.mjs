/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The verdict of scripts/ci-viewer-select.mjs: run the selected viewer test
 * files (retrying failed ones once, as the queue's shards do), and post the
 * result as the commit status STATUS_CONTEXT, which .mergify.yml gates queue
 * entry on. See that script's header for why a verdict is a status and never
 * a red job.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_RETRY_FILES, attributeViewerFailures, decideMode, incompleteViewerAttempt, judgeViewerRetry, parseNodeTap, planRetry,
} from './shard-retry.mjs';

/** The most the retries of failed files may take together. */
export const RETRY_BUDGET_SECONDS = 300;

/**
 * Run the selected files once, and when that fails and `CI_SHARD_RETRY=on`,
 * rerun each failed file once on its own, as scripts/ci-shard-retry.mjs does
 * for the queue's shards and with the same fail-closed rules
 * (scripts/lib/shard-retry.mjs): the attempt's TAP must be complete, every
 * failure tied to a selected file, at most MAX_RETRY_FILES of them, and each
 * rerun must pass the very tests that failed. `files` are relative to `cwd`
 * (apps/viewer); `runner` is the viewer `test` script's tsx argv (runnerArgs).
 *
 * @returns {{ files: number, exitCode: number, signal: string|null, failedFiles: string[], retry: { mode: string, plan: { retry: boolean, reason: string }, passed?: boolean, reason?: string } | null, passed: boolean }}
 */
export function runSelected({ files, dir, env, cwd, runner: [bin, ...args] }) {
  // A TAP copy for the retry to read; `timeoutSeconds` wraps it in coreutils
  // `timeout`, which signals the whole process group, as ci-shard-retry.mjs does.
  const tsx = (list, tap, timeoutSeconds) => {
    const cmd = ['pnpm', 'exec', bin, ...args, '--test-reporter=tap', `--test-reporter-destination=${tap}`, ...list];
    const [exe, ...rest] = timeoutSeconds ? ['timeout', '--kill-after=30s', `${timeoutSeconds}s`, ...cmd] : cmd;
    return spawnSync(exe, rest, { cwd, stdio: 'inherit' });
  };
  const tap1 = join(dir, 'attempt1.tap');
  const r = tsx(files, tap1);
  if (r.error) throw r.error;
  const exitCode = r.status ?? 1;
  const base = { files: files.length, exitCode, signal: r.signal ?? null };
  if (exitCode === 0) return { ...base, failedFiles: [], retry: null, passed: true };
  const first = existsSync(tap1) ? parseNodeTap(readFileSync(tap1, 'utf8')) : null;
  const attributed = first ? attributeViewerFailures(first.failures, realpathSync(cwd)) : { files: [], tests: [], unattributed: [] };
  const outside = attributed.files.filter((f) => !files.includes(f));
  const { mode, warning } = decideMode(env.CI_SHARD_RETRY);
  if (warning) console.log(`::warning::${warning}`);
  // `shadow` keeps the first verdict, as on the shards; only `on` retries here.
  const plan = mode === 'on'
    ? planRetry({
      mode,
      count: attributed.files.length,
      cap: MAX_RETRY_FILES,
      unattributed: attributed.unattributed,
      refusal: first === null ? 'the first attempt left no TAP file'
        : incompleteViewerAttempt(first) ?? (outside.length > 0 ? `failure(s) in file(s) not selected: ${outside.join(', ')}` : undefined),
    })
    : { retry: false, reason: `CI_SHARD_RETRY is ${mode}; only \`on\` retries` };
  const retry = { mode, plan };
  if (plan.retry) {
    const deadline = Date.now() + RETRY_BUDGET_SECONDS * 1000;
    retry.passed = true;
    for (const [i, file] of attributed.files.entries()) {
      const left = Math.floor((deadline - Date.now()) / 1000);
      let verdict;
      if (left < 1) verdict = { passed: false, reason: 'the retry budget ran out before this file' };
      else {
        console.log(`[ci-viewer-select] rerunning ${file}`);
        const tap = join(dir, `retry-${i}.tap`);
        const again = tsx([file], tap, left);
        const parsed = existsSync(tap) ? parseNodeTap(readFileSync(tap, 'utf8')) : null;
        verdict = judgeViewerRetry({ exitCode: again.status, summary: parsed?.summary ?? null, passed: parsed?.passed, tests: attributed.tests.filter((t) => t.file === file) });
      }
      if (!verdict.passed) {
        retry.passed = false;
        retry.reason = `${file}: ${verdict.reason}`;
        break;
      }
    }
    if (retry.passed) retry.reason = `all ${attributed.files.length} failed file(s) passed on retry`;
  }
  return { ...base, failedFiles: attributed.files, retry, passed: retry.passed === true };
}

/** The commit status context .mergify.yml gates queue entry on. */
export const STATUS_CONTEXT = 'PR viewer selection';

/** GitHub caps a status description at 140 characters. */
const clip = (s) => (s.length <= 140 ? s : `${s.slice(0, 139)}…`);

/**
 * The status to post. `phase` start is pending; otherwise success only on
 * positive evidence: nothing selected to run, or a result that passed.
 * Anything else (a select step that failed, tests that did not finish, a
 * failure the retry did not clear) is failure.
 *
 * @param {{ phase?: string, run?: string, selectOutcome?: string, result?: object|null }} input
 * @returns {{ state: 'pending'|'success'|'failure', description: string }}
 */
export function selectionStatus({ phase, run, selectOutcome, result }) {
  if (phase === 'start') return { state: 'pending', description: 'Running the viewer test files this PR reaches' };
  if (selectOutcome !== 'success') return { state: 'failure', description: clip(`The test selection step ended ${selectOutcome || 'without running'}; re-run this job`) };
  if (run !== 'true') return { state: 'success', description: 'No viewer test file selected to run' };
  if (!result) return { state: 'failure', description: 'The selected viewer tests did not finish; re-run this job' };
  if (result.passed === true) {
    const retried = result.retry?.passed ? `, ${result.failedFiles.length} after a retry` : '';
    return { state: 'success', description: clip(`${result.files} selected viewer test file(s) passed${retried}`) };
  }
  const named = result.failedFiles?.length > 0 ? `${result.failedFiles.length} of ${result.files} selected viewer test file(s) failed: ${result.failedFiles.join(', ')}` : `Selected viewer tests failed (exit ${result.exitCode})`;
  return { state: 'failure', description: clip(named) };
}

/** The job's page (RUN_URL + `/job/` + CHECK_RUN_ID), or the run's when the id is unknown. */
function targetUrl(env) {
  if (!env.RUN_URL) return {};
  return { target_url: /^\d+$/.test(env.CHECK_RUN_ID ?? '') ? `${env.RUN_URL}/job/${env.CHECK_RUN_ID}` : env.RUN_URL };
}

/** `--status <dir>`: post selectionStatus on the PR head. */
export async function postStatus(argv, env = process.env, fetchImpl = globalThis.fetch) {
  const dir = argv[1];
  if (!dir) throw new Error('usage: --status <dir>');
  const resultPath = join(dir, 'result.json');
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const status = selectionStatus({ phase: env.PHASE, run: env.RUN, selectOutcome: env.SELECT_OUTCOME, result });
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'HEAD_SHA']) if (!env[name]) throw new Error(`${name} is not set`);
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetchImpl(`${api}/repos/${env.GITHUB_REPOSITORY}/statuses/${env.HEAD_SHA}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ state: status.state, context: STATUS_CONTEXT, description: status.description, ...targetUrl(env) }),
  });
  if (!res.ok) throw new Error(`posting ${STATUS_CONTEXT}=${status.state} on ${env.HEAD_SHA} failed: HTTP ${res.status} ${await res.text()}`);
  console.log(`[ci-viewer-select] ${STATUS_CONTEXT}: ${status.state} (${status.description}) on ${env.HEAD_SHA}`);
  return 0;
}
