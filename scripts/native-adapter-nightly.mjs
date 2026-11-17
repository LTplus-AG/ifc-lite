#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `range --out <file>`: the commits a nightly native-adapter run covers, run
 * by geometry-platform.yml's `nightly-range` job. That is every first-parent
 * commit on main after the last green FULL run (both native-adapter and the
 * corpus aggregate green, read from the run history) up to this run's HEAD.
 * Writes `head`, `last_green`, `count` and `detail` to $GITHUB_OUTPUT, the
 * record as JSON to --out (the artifact native-adapter-bisect.yml reads), and
 * the detail to the job summary.
 *
 * It FAILS, after writing a detail that says why, when no green record is in
 * the scanned history or the record is not an ancestor of HEAD (main was
 * rewritten). The lane does not depend on it, so it still runs; the failure
 * reaches the tracking issue through report-scheduled-failure.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { assertSha, firstParentRange, isAncestor, jobsOf, lastGreenRun, rangeDetail, WORKFLOW, writeOutputs } from './lib/native-adapter-nightly.mjs';
import { gh } from './lib/gh.mjs';

/** Runs scanned for a record: 300, months of nights. Older than that is a broken lane, not a range. */
const MAX_PAGES = 3;

/** Every completed run of the lane, newest first, fetched a page at a time as the scan needs it. */
function* completedRuns(repo, api) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const runs = api(`repos/${repo}/actions/workflows/${posix.basename(WORKFLOW)}/runs?branch=main&status=completed&per_page=100&page=${page}`)?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error('the workflow runs listing has no workflow_runs array');
    yield* runs;
    if (runs.length < 100) return;
  }
}

/** The coverage record for `head` and its issue-ready detail, or throws with a reason fit for the issue. */
export function coverageRange({ cwd, repo, server, head, runId }, api) {
  assertSha('head', head);
  const green = lastGreenRun(completedRuns(repo, api), (run) => jobsOf(repo, api, run.id), runId);
  if (!green) throw new Error(`no green full run of ${WORKFLOW} on main in its last ${MAX_PAGES * 100} completed runs; the range since the last covered commit is unknown`);
  const lastGreen = assertSha('the last green run\'s head_sha', green.head_sha);
  if (!isAncestor(cwd, lastGreen, head)) throw new Error(`the last green run's commit ${lastGreen} (${green.html_url}) is not an ancestor of ${head}; main was rewritten, so the range is unknown`);
  const commits = firstParentRange(cwd, lastGreen, head);
  const detail = rangeDetail({ server, repo, head, lastGreen, lastGreenUrl: green.html_url, commits });
  return { record: { head, last_green: lastGreen, commits }, detail };
}

/** The step outputs, and the detail in the job summary. */
function report(env, outputs) {
  if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, outputs);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Nightly coverage range\n\n${outputs.detail}\n`);
}

if (isMainEntry(import.meta.url)) {
  const [command, flag, out] = process.argv.slice(2);
  if (command !== 'range' || flag !== '--out' || !out) {
    console.error('usage: native-adapter-nightly.mjs range --out <file>');
    process.exit(2);
  }
  const env = process.env;
  const head = env.GITHUB_SHA;
  try {
    const { record, detail } = coverageRange({ cwd: process.cwd(), repo: env.GITHUB_REPOSITORY, server: env.GITHUB_SERVER_URL ?? 'https://github.com', head, runId: env.GITHUB_RUN_ID }, (path) => gh(['api', path], path));
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    report(env, { head: record.head, last_green: record.last_green, count: record.commits.length, detail });
    console.log(detail);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    report(env, { head: head ?? '', detail: `The coverage range could not be established: ${reason}\nNo bisect can run until a full run on main is green again.` });
    console.error(`❌ native-adapter-nightly: ${reason}`);
    process.exit(1);
  }
}
