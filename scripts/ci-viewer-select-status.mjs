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
 * failing nor pending. A status is per sha, so a push starts clean and a
 * failure on an older head can never hold the new one. An ABSENT status
 * passes (a fork PR, a run whose `changes` job died before posting).
 *
 *   --entry     the last step of the `changes` job, on every same-repo PR run
 *               that decides anything (not a no-op `edited` replay, which
 *               keeps the earlier verdict; not a Mergify batch PR):
 *                 gated (switch `on`, fast lane, frontend or Rust touched:
 *                 exactly the tests job's `if:`)  -> `pending`, so the gate
 *                 is closed from the first job of the run, before the build;
 *                 otherwise -> `success`, "Not gated on this run (<why>)".
 *               The second half RELEASES a hold an earlier run on the same
 *               sha left behind: `ci:full` plus close/reopen runs every viewer
 *               shard, and flipping CI_PR_VIEWER_SELECT off is an emergency
 *               rollback that frees every held PR on its next run. Exits 0
 *               even when the post fails (logged as a warning): that FAILS
 *               OPEN for the run (no pending, so the gate stays open until the
 *               verdict), which is deliberate: a status API blip must not
 *               turn the `changes` job, and so every lane, red.
 *   --final <dir>
 *               the tests job's last-but-one step, on always(): success when
 *               the selected files passed (a file that passed on the
 *               CI_SHARD_RETRY=on retry counts) or nothing was selected;
 *               failure when one failed, or the select or run step broke.
 *               A CANCELLED job posts nothing: its pending stays (fail
 *               closed), and a cancelling newer run on the same sha posts its
 *               own status, which a late "cancelled" post must not overwrite.
 *               Exits 1 when the post fails, which shows on the advisory
 *               job; the pending status then still holds the gate.
 *
 * ORDERING on one sha (the status is last-write-wins): within a run, entry
 * precedes the verdict (the tests job needs `changes`). Across runs, test.yml's
 * concurrency group cancels an older non-`edited` run when a newer one starts,
 * and a cancelled run posts nothing, so its verdict cannot land after the
 * newer run's entry. An `edited` run is not cancelling: it queues behind the
 * running one, so it starts after that verdict is posted, and a no-op edit
 * posts nothing. A verdict POST already in flight at the instant of
 * cancellation is the one residue (sub-second, against the newer run's
 * runner pickup, checkout and lane steps).
 *
 * Posts nothing for a fork PR: its token cannot write statuses, so there the
 * queue's full run stays the only gate. `--final` posts only in `on`.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL,
 * GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, HEAD_SHA, HEAD_REPO, CI_PR_VIEWER_SELECT;
 * for --entry also EVENT, LANE, BATCH, NOOP, FRONTEND, RUST; for --final
 * JOB_NAME, JOB_STATUS, SELECT_OUTCOME, SELECT_RUN, RUN_OUTCOME.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMainEntry } from './lib/is-main-entry.mjs';

export const STATUS_CONTEXT = 'PR viewer selection';
/** GitHub truncates nothing: a longer description is a 422. */
const MAX_DESCRIPTION = 140;

const clip = (s) => (s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 3)}...`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const isOn = (mode) => String(mode ?? '').toLowerCase() === 'on';

/**
 * Does this run gate queue entry? The same clauses as test.yml's
 * `viewer-tests-selected` `if:` with the switch at `on` (pinned in the test).
 * Lowercased and not trimmed, like Actions' `==`.
 * @returns {{ gated: true } | { gated: false, why: string }}
 */
export function gateApplies({ mode, lane, frontend, rust }) {
  if (!isOn(mode)) return { gated: false, why: `CI_PR_VIEWER_SELECT is ${JSON.stringify(String(mode ?? ''))}` };
  if (lane !== 'fast') return { gated: false, why: 'full lane: every viewer shard runs' };
  if (frontend !== 'true' && rust !== 'true') return { gated: false, why: 'no frontend or Rust change' };
  return { gated: true };
}

/**
 * What to post, or why nothing is posted.
 * @param {{ phase: 'entry'|'final', mode?: string, headRepo?: string, repo?: string,
 *   event?: string, lane?: string, batch?: string, noop?: string, frontend?: string, rust?: string,
 *   jobStatus?: string, selectOutcome?: string, run?: string, runOutcome?: string,
 *   result?: { files: number, passed: boolean, failedFiles?: string[], passedOnRetry?: string[] } | null }} input
 * @returns {{ post: false, reason: string } | { post: true, state: 'pending'|'success'|'failure', description: string }}
 */
export function decideStatus(input) {
  const { phase, mode, headRepo, repo } = input;
  if (!repo || headRepo !== repo) return { post: false, reason: 'the head is not in this repository (fork PR): its token cannot write statuses, so the merge queue run is the gate' };
  const post = (state, description) => ({ post: true, state, description: clip(description) });
  if (phase === 'entry') {
    if (input.event !== 'pull_request') return { post: false, reason: `a ${input.event || 'unknown'} run has no PR head to gate` };
    if (input.batch === 'true') return { post: false, reason: 'a Mergify batch PR is the queue run itself' };
    if (input.noop === 'true') return { post: false, reason: 'a no-op edit replays the earlier verdict, which stands' };
    const gate = gateApplies(input);
    return gate.gated ? post('pending', 'Selected viewer tests are running') : post('success', `Not gated on this run (${gate.why})`);
  }
  if (!isOn(mode)) return { post: false, reason: 'CI_PR_VIEWER_SELECT is not `on`; this run posted "not gated" from the changes job' };
  if (input.jobStatus === 'cancelled') return { post: false, reason: 'cancelled: the pending status stays, and a newer run on this sha posts its own' };
  const { selectOutcome, run, runOutcome, result } = input;
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
  if (cmd !== '--entry' && !(cmd === '--final' && dir)) throw new Error('usage: --entry | --final <dir>');
  const phase = cmd === '--entry' ? 'entry' : 'final';
  const decision = decideStatus({
    phase,
    mode: env.CI_PR_VIEWER_SELECT,
    headRepo: env.HEAD_REPO,
    repo: env.GITHUB_REPOSITORY,
    event: env.EVENT,
    lane: env.LANE,
    batch: env.BATCH,
    noop: env.NOOP,
    frontend: env.FRONTEND,
    rust: env.RUST,
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
    return phase === 'entry' ? 0 : 1;
  }
  console.log(`[ci-viewer-select-status] ${STATUS_CONTEXT}: ${decision.state} on ${env.HEAD_SHA}: ${decision.description}`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(`[ci-viewer-select-status] ERROR: ${err.message}`);
    // As a failed post: --entry must not turn the `changes` job red.
    process.exitCode = process.argv[2] === '--entry' ? 0 : 1;
  });
}
