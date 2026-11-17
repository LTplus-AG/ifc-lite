#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The steps of native-adapter-bisect.yml, which names the first bad commit
 * after a red nightly native-adapter run. Each workflow run probes one commit
 * and dispatches the next, so a bisect holds one runner (plus the failed
 * shards) at a time and never outlives a job's time limit.
 *
 *   plan  Started by the red nightly (workflow_run): reads which jobs failed
 *         and the run's nightly-range record, posts that a bisect started,
 *         and probes the red HEAD again first (`confirm`), so a flaky failure
 *         is reported as flaky rather than bisected onto an innocent commit.
 *         Dispatched: probes the midpoint of good..bad.
 *   next  Reads the probe's result, narrows the range, then dispatches the
 *         next round or posts the verdict on the nightly tracking issue.
 *
 * Every step's outputs go to $GITHUB_OUTPUT; `notice` is something `next`
 * must post even though nothing was probed.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { gh } from './lib/gh.mjs';
import { assertSha, BISECT_FILE, bisectNext, changedBetween, failedTarget, firstParentRange, isAncestor, jobsOf, NIGHTLY_LABEL, PROBE_HARNESS, probeFor, SHARD_INPUTS, short, WORKFLOW_NAME, writeOutputs } from './lib/native-adapter-nightly.mjs';
import { fileOnIssue, realGh, scheduledIssueTitle } from './report-scheduled-failure.mjs';

/** A bisect of 2^30 commits needs 31 rounds; more than this is a loop, not a bisect. */
const MAX_ROUNDS = 40;
const what = ({ adapter, shards }) => [adapter ? 'native-adapter' : null, shards.length > 0 ? `corpus shard(s) ${shards.join(', ')}` : null].filter(Boolean).join(' and ');

/** The command that starts a bisect round by hand. */
const resume = (good, bad, phase, target) => `\`gh workflow run ${BISECT_FILE} -f good=${good} -f bad=${bad} -f phase=${phase} -f adapter=${target.adapter} -f shards='${JSON.stringify(target.shards)}'\``;

const parseShards = (text) => {
  if (!text) return [];
  const shards = JSON.parse(text);
  if (!Array.isArray(shards) || shards.some((s) => !Number.isInteger(s) || s < 0)) throw new Error(`shards must be a JSON array of shard indices, got ${text}`);
  return shards;
};

/** Plan outputs for a probe of `probe` in state { good, bad, phase, target, round }. */
const planOutputs = ({ good, bad, phase, target, round, probe }) => ({
  probe, good, bad, phase, round,
  adapter: String(target.adapter),
  shards: target.shards.length > 0 ? JSON.stringify(target.shards) : '',
  notice: '',
});

/** The state a run starts from: the red nightly's jobs and record, or the dispatch inputs. */
export function plan(env, { api, cwd, download }) {
  const repo = env.GITHUB_REPOSITORY;
  if (env.EVENT === 'workflow_run') {
    const runId = env.NIGHTLY_RUN_ID;
    const red = `the red nightly run ${env.NIGHTLY_RUN_URL}`;
    const skip = (notice) => ({ probe: '', notice });
    const jobs = jobsOf(repo, api, runId);
    const { adapter, shards, total, aggregateOnly } = failedTarget(jobs);
    const target = { adapter, shards };
    const aggregateNote = aggregateOnly ? ' The corpus aggregate also failed with every shard green; a probe cannot re-run it, so read its log.' : '';
    if (!adapter && aggregateOnly) return skip(`No bisect for ${red}: only the corpus aggregate failed, with every shard green (a cross-shard check, the product merge, the exclusion report, or a matrix that never expanded). A probe cannot re-run the aggregate, so read its log.`);
    // No lane job failed, yet the run is red: name what did not succeed rather than staying silent (#10629 review r4603499517).
    if (!adapter && shards.length === 0) {
      const notGreen = jobs.filter((j) => j?.conclusion !== 'success').map((j) => `${j?.name} (${j?.conclusion ?? 'no conclusion'})`);
      const missing = jobs.some((j) => j?.name === 'native-adapter') ? '' : ' native-adapter is not in the run\'s job listing.';
      return skip(`No bisect for ${red}: no native-adapter or corpus shard job failed, so there is nothing to re-run.${missing} Jobs that did not succeed: ${notGreen.join(', ') || 'none listed'}. Read their logs in the run.`);
    }
    // One bisect at a time: red nights in a row share their last green commit, so a second one would redo the first.
    const running = ['in_progress', 'queued'].flatMap((status) => api(`repos/${repo}/actions/workflows/${BISECT_FILE}/runs?status=${status}&per_page=100`)?.workflow_runs ?? []).filter((r) => String(r.id) !== String(env.GITHUB_RUN_ID));
    if (running.length > 0) return skip(`No new bisect for ${red}: one is already running (${running[0].html_url}) over an overlapping range. If its verdict does not explain this night, bisect by hand: ${resume('<last green sha>', '<red sha>', 'confirm', target)}.`);
    let record;
    try {
      record = download(runId);
    } catch (err) {
      return skip(`No bisect for ${red}: it has no nightly-range record (${err.message}), so the commit range is unknown. Bisect by hand: ${resume('<last green sha>', '<red sha>', 'confirm', target)}.`);
    }
    const good = assertSha('the record\'s last_green', record.last_green);
    const bad = assertSha('the record\'s head', record.head);
    const count = firstParentRange(cwd, good, bad).length;
    if (count === 0) return skip(`No bisect for ${red}: it ran the same commit as the last green run (${short(bad)}), so the cause is outside the repo (runner image, fetched SDK or corpus, a service) or a flake. Re-run the failed jobs to tell which.${aggregateNote}`);
    const notes = [aggregateNote];
    // Shards are cut by model bytes from these inputs, so the same index can hold other models at another commit.
    if (shards.length > 0 && changedBetween(cwd, good, bad, SHARD_INPUTS)) {
      target.shards = Array.from({ length: total }, (_, i) => i);
      notes.push(' The range changes how models are sharded, so every probe re-runs all shards.');
    }
    if (changedBetween(cwd, good, bad, PROBE_HARNESS)) notes.push(` The range changes ${PROBE_HARNESS.join(' or ')}; every probe runs main's copy, so check the verdict against that change.`);
    const state = { good, bad, phase: 'confirm', target, round: 1 };
    return { ...planOutputs({ ...state, probe: bad }), start: `Bisect started for ${red}: ${count} commit(s) after ${short(good)} up to ${short(bad)}, re-running ${what(target)} only. It first re-runs ${short(bad)} to rule out a flake.${notes.join('')} Run: ${env.BISECT_RUN_URL}` };
  }
  const state = {
    good: assertSha('good', env.GOOD),
    bad: assertSha('bad', env.BAD),
    phase: env.PHASE === 'bisect' ? 'bisect' : 'confirm',
    target: { adapter: env.ADAPTER === 'true', shards: parseShards(env.SHARDS) },
    round: Number(env.ROUND || 1),
  };
  if (!state.target.adapter && state.target.shards.length === 0) throw new Error('nothing to probe: adapter is false and shards is empty');
  if (!isAncestor(cwd, state.good, state.bad)) throw new Error(`good ${state.good} is not an ancestor of bad ${state.bad}`);
  const range = firstParentRange(cwd, state.good, state.bad);
  return planOutputs({ ...state, probe: probeFor(state.phase, state.bad, range) });
}

/** What the probe's result means: the next dispatch's inputs, or a verdict to post. */
export function next(env, { cwd }) {
  const target = { adapter: env.ADAPTER === 'true', shards: parseShards(env.SHARDS) };
  const round = Number(env.ROUND);
  const state = { phase: env.PHASE, good: env.GOOD, bad: env.BAD, probe: env.PROBE, result: env.PROBE_RESULT };
  const step = bisectNext(state, (good, bad) => firstParentRange(cwd, good, bad));
  const run = `Bisect run: ${env.BISECT_RUN_URL}`;
  if (step.done) {
    const body = {
      culprit: () => `First bad commit: ${env.SERVER}/${env.GITHUB_REPOSITORY}/commit/${step.culprit?.sha} (${step.culprit?.subject}). Its parent ${short(step.good)} passes ${what(target)}.${changedBetween(cwd, step.culprit.sha, 'HEAD', PROBE_HARNESS) ? ` The probes ran main's ${PROBE_HARNESS.join(' and ')}, which differ from this commit's; re-check by hand.` : ''} ${run}`,
      flaky: () => `The failure did not reproduce: ${what(target)} passed on a re-run of ${short(step.bad)}. Not bisecting; treat the nightly failure as flaky, and check the failed run's logs. ${run}`,
      interrupted: () => `Bisect stopped: the probe of ${short(state.probe)} ended \`${state.result}\`, not success or failure. Resume with ${resume(step.good, step.bad, state.phase, target)}. ${run}`,
      empty: () => `Bisect stopped: no commits between ${short(step.good)} and ${short(step.bad)}. ${run}`,
    }[step.verdict]();
    return { post: body };
  }
  if (round >= MAX_ROUNDS) return { post: `Bisect stopped after ${round} rounds with ${step.remaining} commits left between ${short(step.good)} and ${short(step.bad)}. Resume with ${resume(step.good, step.bad, 'bisect', target)}. ${run}` };
  return { dispatch: ['workflow', 'run', BISECT_FILE, '--repo', env.GITHUB_REPOSITORY, '--ref', 'main', '-f', `good=${step.good}`, '-f', `bad=${step.bad}`, '-f', 'phase=bisect', '-f', `adapter=${target.adapter}`, '-f', `shards=${env.SHARDS ?? ''}`, '-f', `round=${round + 1}`] };
}

const post = (env, body, gh) => fileOnIssue({ repo: env.GITHUB_REPOSITORY, title: scheduledIssueTitle(WORKFLOW_NAME), body, labels: [NIGHTLY_LABEL] }, gh);

function downloadRecord(repo, runId) {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-range-'));
  try {
    realGh(['run', 'download', String(runId), '--repo', repo, '--name', 'nightly-range', '--dir', dir]);
    return JSON.parse(readFileSync(join(dir, 'nightly-range.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const env = process.env;
  const command = process.argv[2];
  const cwd = process.cwd();
  if (command === 'plan') {
    const out = plan(env, { api: (path) => gh(['api', path], path), cwd, download: (runId) => downloadRecord(env.GITHUB_REPOSITORY, runId) });
    if (out.start) post(env, out.start, realGh);
    const { start: _start, ...outputs } = out;
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    console.log(JSON.stringify(outputs));
  } else if (command === 'next') {
    if (env.PLAN_RESULT !== 'success') {
      post(env, `Bisect could not plan (plan job: ${env.PLAN_RESULT}). Bisect run: ${env.BISECT_RUN_URL}`, realGh);
    } else if (!env.PROBE) {
      if (env.NOTICE) post(env, env.NOTICE, realGh);
    } else {
      const step = next(env, { cwd });
      if (step.post) post(env, step.post, realGh);
      if (step.dispatch) realGh(step.dispatch);
      console.log(step.post ?? `dispatched: ${step.dispatch.join(' ')}`);
    }
  } else {
    console.error('usage: native-adapter-bisect.mjs plan|next');
    process.exit(2);
  }
}
