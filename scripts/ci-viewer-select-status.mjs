#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `PR viewer selection` commit status: the selected viewer tests'
 * verdict (scripts/ci-viewer-select.mjs), posted on the PR HEAD sha so
 * Mergify can hold a failing PR out of the merge queue without the Test run
 * turning red (a red run is never push-replayed, scripts/ci-push-replay.mjs).
 *
 * .mergify.yml's auto_merge_conditions require the status to be neither
 * failing nor pending. An ABSENT status passes: the job did not run (full
 * lane, docs-only, switch not `on`, fork PR), so there is no verdict to wait
 * for. A status is per sha, so a push starts clean and a failure on an older
 * head can never hold the new one.
 *
 *   --pending   posted by the `viewer-selection-pending` job as soon as the
 *               lane is known, before the build, so the gate cannot open in
 *               the minutes before the tests report. Exits 0 even when the
 *               post fails: the tests job depends on this one.
 *   --final <dir>
 *               posted by the tests job's last-but-one step, on always():
 *               success when the selected files passed (a file that passed
 *               on the CI_SHARD_RETRY=on retry counts) or nothing was
 *               selected; failure when one failed, or the job could not
 *               produce a verdict (cancelled, the select or run step broke).
 *               Exits 1 when the post fails, which shows on the advisory
 *               job; the pending status then still holds the gate.
 *
 * Posts only when CI_PR_VIEWER_SELECT is `on` (`shadow` gates nothing) and
 * the head is in this repository: a fork PR's token cannot write statuses,
 * so there the queue's full run stays the only gate.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL,
 * GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, HEAD_SHA, HEAD_REPO, CI_PR_VIEWER_SELECT;
 * for --final also JOB_NAME, JOB_STATUS, SELECT_OUTCOME, SELECT_RUN,
 * RUN_OUTCOME.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMainEntry } from './lib/is-main-entry.mjs';

export const STATUS_CONTEXT = 'PR viewer selection';
/** GitHub truncates nothing: a longer description is a 422. */
const MAX_DESCRIPTION = 140;

const clip = (s) => (s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 3)}...`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What to post, or why nothing is posted.
 * @param {{ phase: 'pending'|'final', mode?: string, headRepo?: string, repo?: string,
 *   jobStatus?: string, selectOutcome?: string, run?: string, runOutcome?: string,
 *   result?: { files: number, passed: boolean, failedFiles?: string[], passedOnRetry?: string[] } | null }} input
 * @returns {{ post: false, reason: string } | { post: true, state: 'pending'|'success'|'failure', description: string }}
 */
export function decideStatus({ phase, mode, headRepo, repo, jobStatus, selectOutcome, run, runOutcome, result }) {
  // Lowercased and not trimmed, like Actions' `==` in the jobs' `if:`.
  if (String(mode ?? '').toLowerCase() !== 'on') return { post: false, reason: `CI_PR_VIEWER_SELECT is not \`on\`; only \`on\` gates queue entry` };
  if (!repo || headRepo !== repo) return { post: false, reason: 'the head is not in this repository (fork PR): its token cannot write statuses, so the merge queue run is the gate' };
  const post = (state, description) => ({ post: true, state, description: clip(description) });
  if (phase === 'pending') return post('pending', 'Selected viewer tests are running');
  if (jobStatus === 'cancelled') return post('failure', 'Cancelled before a verdict; re-run the job');
  if (selectOutcome !== 'success') return post('failure', `The selection step ended ${selectOutcome || 'unrun'}; re-run the job`);
  if (run !== 'true') return post('success', 'No viewer test file selected for this change');
  if (runOutcome !== 'success' || !result) return post('failure', `The selected tests did not report (step ${runOutcome || 'unrun'}); re-run the job`);
  if (result.passed) {
    const retried = result.passedOnRetry?.length ?? 0;
    return post('success', `${plural(result.files, 'selected file')} passed${retried > 0 ? ` (${retried} after a retry)` : ''}`);
  }
  const failed = result.failedFiles ?? [];
  if (failed.length === 0) return post('failure', `${plural(result.files, 'selected file')} ran; a failure no file could be tied to`);
  return post('failure', `${failed.length} of ${plural(result.files, 'selected file')} failed: ${failed.join(', ')}`);
}

function readResult(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`::warning::result.json is unreadable (${err.message})`);
    return null;
  }
}

async function api(env, method, path, body) {
  const res = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** The job's own page, else the run's (one read; any error falls back). */
async function targetUrl(env) {
  const runUrl = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  if (!env.JOB_NAME) return runUrl;
  try {
    const { jobs } = await api(env, 'GET', `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || 1}/jobs?per_page=100`);
    return jobs.find((j) => j.name === env.JOB_NAME)?.html_url ?? runUrl;
  } catch (err) {
    console.log(`[ci-viewer-select-status] job URL lookup failed (${err.message}); linking the run`);
    return runUrl;
  }
}

export async function main(argv, env = process.env) {
  const [cmd, dir] = argv;
  if (cmd !== '--pending' && !(cmd === '--final' && dir)) throw new Error('usage: --pending | --final <dir>');
  const phase = cmd === '--pending' ? 'pending' : 'final';
  const decision = decideStatus({
    phase,
    mode: env.CI_PR_VIEWER_SELECT,
    headRepo: env.HEAD_REPO,
    repo: env.GITHUB_REPOSITORY,
    jobStatus: env.JOB_STATUS,
    selectOutcome: env.SELECT_OUTCOME,
    run: env.SELECT_RUN,
    runOutcome: env.RUN_OUTCOME,
    result: phase === 'final' ? readResult(dir) : null,
  });
  if (!decision.post) {
    console.log(`[ci-viewer-select-status] not posting: ${decision.reason}`);
    return 0;
  }
  if (!/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? '')) throw new Error(`HEAD_SHA is not a commit sha: ${JSON.stringify(env.HEAD_SHA)}`);
  const body = { state: decision.state, context: STATUS_CONTEXT, description: decision.description, target_url: await targetUrl(env) };
  try {
    await api(env, 'POST', `repos/${env.GITHUB_REPOSITORY}/statuses/${env.HEAD_SHA}`, body);
  } catch (err) {
    console.log(`::warning title=${STATUS_CONTEXT}::could not post the ${decision.state} status: ${err.message}`);
    return phase === 'pending' ? 0 : 1;
  }
  console.log(`[ci-viewer-select-status] ${STATUS_CONTEXT}: ${decision.state} on ${env.HEAD_SHA}: ${decision.description}`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(`[ci-viewer-select-status] ERROR: ${err.message}`);
    // As a failed post: --pending must not skip the tests job behind it.
    process.exitCode = process.argv[2] === '--pending' ? 0 : 1;
  });
}
