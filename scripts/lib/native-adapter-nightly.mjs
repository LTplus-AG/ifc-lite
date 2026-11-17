/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The nightly native-adapter run (geometry-platform.yml on `schedule`) is what
 * covers main for every path a merge-queue batch skips (BATCH_EXCLUDE in
 * native-adapter-batch.mjs). This module is what makes that coverage hold:
 *
 *   - the coverage record: the last green FULL run on main, read from GitHub's
 *     own run and job history, so a cancelled, missing or red night widens the
 *     next range instead of dropping commits;
 *   - what a red run's bisect must re-run (the native-adapter job, failed shards);
 *   - one step of that bisect over the first-parent commits since the record;
 *   - nightlyProblems, the audit that this route stays wired.
 *
 * The CLIs are scripts/native-adapter-nightly.mjs (range) and
 * scripts/native-adapter-bisect.mjs (plan, next). Node built-ins only: the
 * audit runs in the lane's first step, before `pnpm install`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { permissionBlocks, workflowAsks } from './workflow-permissions.mjs';

export const WORKFLOW = '.github/workflows/geometry-platform.yml';
export const WORKFLOW_FILE = posix.basename(WORKFLOW);
export const WORKFLOW_NAME = 'Geometry platform (native adapter)';
const BISECT_WORKFLOW = '.github/workflows/native-adapter-bisect.yml';
export const BISECT_FILE = posix.basename(BISECT_WORKFLOW);
/** The label every nightly failure report and bisect verdict carries. */
export const NIGHTLY_LABEL = 'nightly-red';
/** Jobs whose success makes a run a green FULL run; the corpus aggregate exists only on one. */
const RECORD_JOBS = ['native-adapter', 'Native corpus result'];
/** The gate of every job that runs only on a full run (nightly, or dispatched with the corpus). */
export const NIGHTLY_IF = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)";

const SHARD = /^Native corpus \(shard (\d+)\/(\d+)\)$/;
const UNSUCCESSFUL = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const FULL_RUN_EVENTS = new Set(['schedule', 'workflow_dispatch']);
const SHA = /^[0-9a-f]{40}$/;

export const assertSha = (name, value) => {
  if (!SHA.test(value ?? '')) throw new Error(`${name} must be a full 40-character commit SHA, got ${JSON.stringify(value)}`);
  return value;
};

/** Whether a run's latest-attempt `jobs` make it a green full run. */
const isGreenRecord = (jobs) => RECORD_JOBS.every((name) => jobs.some((j) => j?.name === name && j.conclusion === 'success'));

/** A run's latest-attempt jobs; `api(path)` is a parsed GET of the REST API. */
export function jobsOf(repo, api, runId) {
  const jobs = api(`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`)?.jobs;
  if (!Array.isArray(jobs)) throw new Error(`the jobs listing of run ${runId} has no jobs array`);
  return jobs;
}

/** Appends `outputs` to $GITHUB_OUTPUT, a multi-line value as a heredoc. */
export function writeOutputs(file, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    const text = String(value);
    if (!text.includes('\n')) return `${key}=${text}\n`;
    const eof = `EOF_${randomUUID()}`;
    return `${key}<<${eof}\n${text}\n${eof}\n`;
  });
  appendFileSync(file, lines.join(''));
}

/**
 * The newest green full run on main, or null. `runs` is newest first (as the
 * API lists them); `jobsOf(run)` returns that run's latest-attempt jobs, and
 * is only asked for runs that could be a record. `current` is this run's id:
 * it and every run created after it (a higher id) are skipped, since a re-run
 * keeps its original commit and a later green run is no record for it.
 */
export function lastGreenRun(runs, jobsOf, current = null) {
  const cur = current ? Number(current) : null;
  for (const run of runs) {
    if (run?.head_branch !== 'main' || !FULL_RUN_EVENTS.has(run.event)) continue;
    if (cur !== null && Number(run.id) >= cur) continue;
    if (isGreenRecord(jobsOf(run))) return run;
  }
  return null;
}

/**
 * What a bisect probe re-runs after a red run: the native-adapter job if it
 * did not succeed, and every shard that did not. `aggregateOnly` marks a red
 * corpus aggregate with every shard green, which no probe can re-run; `total`
 * is the shard count, for re-running every shard when the range reshards.
 */
export function failedTarget(jobs) {
  const bad = (name) => jobs.some((j) => j?.name === name && UNSUCCESSFUL.has(j.conclusion));
  let total = 0;
  const shards = [];
  for (const job of jobs) {
    const m = job?.name?.match(SHARD);
    if (!m) continue;
    total = Number(m[2]);
    if (UNSUCCESSFUL.has(job.conclusion)) shards.push(Number(m[1]));
  }
  // The aggregate failed with every shard green (a cross-shard check, the merge, the exclusion report, or a
  // matrix that never expanded): a probe cannot run the aggregate, so re-running shards would read as a flake.
  const aggregateOnly = shards.length === 0 && bad('Native corpus result');
  return { adapter: bad('native-adapter'), shards: shards.sort((a, b) => a - b), total, aggregateOnly };
}

/** Inputs that decide which models a corpus shard holds; a range that changes one moves models between shards. */
export const SHARD_INPUTS = ['tests/models/manifest.json', 'scripts/retained-compare/corpus-exclusions.json', 'scripts/retained-compare/corpus-shards.mjs'];
/** What a probe takes from main rather than the probed commit: the lane's workflow. Local actions resolve from the probed checkout. */
export const PROBE_HARNESS = [WORKFLOW];

/** Whether any commit after `from` up to `to` touches `paths`, even if a later one reverts it. */
export function touchedInRange(cwd, from, to, paths) {
  return execFileSync('git', ['-C', cwd, 'log', '--first-parent', '--format=%H', '-1', `${from}..${to}`, '--', ...paths], { encoding: 'utf8' }).trim() !== '';
}

/** The corpus shard count, from the native-corpus matrix of the workflow at `cwd`. */
export function shardCount(cwd) {
  const m = readFileSync(join(cwd, WORKFLOW), 'utf8').match(/^ {8}shard: \$\{\{ fromJSON\(inputs\.bisect_shards \|\| '\[([0-9, ]+)\]'\) \}\}\s*$/m);
  if (!m) throw new Error(`cannot read the native-corpus shard matrix from ${WORKFLOW}`);
  return m[1].split(',').length;
}

/** Whether `paths` differ between two commits. */
export function changedBetween(cwd, from, to, paths) {
  const r = spawnSync('git', ['-C', cwd, 'diff', '--quiet', from, to, '--', ...paths], { encoding: 'utf8' });
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new Error(`git diff ${from} ${to} failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
}

/** First-parent commits after `from` up to and including `to`, oldest first, as { sha, subject }. */
export function firstParentRange(cwd, from, to) {
  const out = execFileSync('git', ['-C', cwd, 'log', '--first-parent', '--reverse', '--format=%H%x09%s', `${from}..${to}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

/** Whether `ancestor` is on `of`'s history; any git error other than "no" throws. */
export function isAncestor(cwd, ancestor, of) {
  const r = spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, of], { encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${of} failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
}

/**
 * The commit a bisect step probes. `range` is firstParentRange(good, bad). A
 * `confirm` step re-runs `bad` itself, so a flaky failure is not bisected onto
 * an innocent commit; a `bisect` step probes the midpoint strictly before `bad`.
 */
export function probeFor(phase, bad, range) {
  if (phase === 'confirm') return bad;
  if (range.length < 2) throw new Error(`a bisect step needs at least two commits in the range, got ${range.length}`);
  return range[Math.floor((range.length - 1) / 2)].sha;
}

/**
 * The state after a probe ended in `result` (a job result: success, failure,
 * cancelled, skipped). `rangeOf(good, bad)` lists the commits in between.
 * Returns { done: true, verdict, ... } or { done: false, good, bad }.
 * Invariant: `good` passed and `bad` failed, so a one-commit range names `bad`.
 */
export function bisectNext({ phase, good, bad, probe, result }, rangeOf) {
  if (result !== 'success' && result !== 'failure') return { done: true, verdict: 'interrupted', good, bad, probe, result };
  if (phase === 'confirm' && result === 'success') return { done: true, verdict: 'flaky', good, bad };
  let next = { good, bad };
  if (phase !== 'confirm') next = result === 'failure' ? { good, bad: probe } : { good: probe, bad };
  const range = rangeOf(next.good, next.bad);
  if (range.length === 0) return { done: true, verdict: 'empty', ...next };
  if (range.length === 1) return { done: true, verdict: 'culprit', culprit: range[0], ...next };
  return { done: false, ...next, remaining: range.length };
}

export const short = (sha) => sha.slice(0, 10);
const LISTED = 30;

/** The issue-ready description of what a nightly run covers. */
export function rangeDetail({ server, repo, head, lastGreen, lastGreenUrl, commits }) {
  const lines = [
    commits.length === 0
      ? `No commits on main since the last green full run; this run re-checks ${short(head)}.`
      : `This run covers ${commits.length} first-parent commit(s) on main since the last green full run.`,
    `- Last green: ${short(lastGreen)} (${lastGreenUrl})`,
    `- This run: ${short(head)}`,
  ];
  if (commits.length > 0) {
    lines.push(`- Compare: ${server}/${repo}/compare/${lastGreen}...${head}`, '', 'Commits, oldest first:');
    for (const c of commits.slice(0, LISTED)) lines.push(`- ${short(c.sha)} \`${c.subject.replaceAll('`', "'")}\``);
    if (commits.length > LISTED) lines.push(`- ... and ${commits.length - LISTED} more (see the compare link)`);
  }
  return lines.join('\n');
}

/** Text of one top-level job (from `  id:` to the next two-space key). */
export function jobBlock(text, id) {
  const m = text.match(new RegExp(`^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

const has = (block, line) => block.split('\n').some((l) => l.trim() === line);

/**
 * The nightly route: what lets a path leave the merge-queue lane (#10619). A
 * scheduled run has no path filter, so it covers every path (BATCH_EXCLUDE's
 * included) as long as it runs the whole lane on main, keeps the coverage
 * record, reports with the range, and the bisect follows a red night.
 * `text` is geometry-platform.yml; the bisect workflow is read from `root`.
 */
export function nightlyProblems(root, text) {
  const out = [];
  const range = jobBlock(text, 'nightly-range');
  if (range === null) {
    out.push(`${WORKFLOW}: no nightly-range job; a red or missing night would drop the commits it did not cover`);
  } else {
    if (!has(range, `if: github.ref == 'refs/heads/main' && (${NIGHTLY_IF})`)) out.push(`${WORKFLOW}: nightly-range must run on every full run of main, gated on exactly: github.ref == 'refs/heads/main' && (${NIGHTLY_IF})`);
    if (/^ {4}needs:/m.test(range)) out.push(`${WORKFLOW}: nightly-range must not need another job; it records the range even when the lane fails`);
    // Some upload-artifact step of the job, however its keys are ordered, uploads the record under its name.
    const uploads = range.split(/^ {6}- /m).filter((step) => /\buses: actions\/upload-artifact@/.test(step));
    const recorded = uploads.some((step) => has(step, 'name: nightly-range') && has(step, `path: \${{ runner.temp }}/nightly-range.json`));
    if (!/run: node scripts\/native-adapter-nightly\.mjs range --out "\$RUNNER_TEMP\/nightly-range\.json"/.test(range) || !recorded) {
      out.push(`${WORKFLOW}: nightly-range must run scripts/native-adapter-nightly.mjs range and upload nightly-range.json as the nightly-range artifact (the bisect reads it)`);
    }
    if (!has(range, 'fetch-depth: 0')) out.push(`${WORKFLOW}: nightly-range needs fetch-depth: 0 to list the commits since the last green run`);
  }
  const reporter = jobBlock(text, 'report-scheduled-failure') ?? '';
  if (!has(reporter, 'needs: [nightly-range, native-adapter, native-corpus-result]')) out.push(`${WORKFLOW}: report-scheduled-failure must need nightly-range, native-adapter and native-corpus-result`);
  if (!has(reporter, "if: always() && github.event_name == 'schedule' && (needs.nightly-range.result != 'success' || needs.native-adapter.result != 'success' || needs.native-corpus-result.result != 'success')")) {
    out.push(`${WORKFLOW}: report-scheduled-failure must report a red nightly-range, native-adapter or native-corpus-result`);
  }
  if (!has(reporter, `detail: \${{ needs.nightly-range.outputs.detail }}`) || !has(reporter, `labels: ${NIGHTLY_LABEL}`)) {
    out.push(`${WORKFLOW}: report-scheduled-failure must pass the nightly-range detail (the commit range) and labels: ${NIGHTLY_LABEL}`);
  }
  // The record and the bisect find jobs by these names in the run's job listing; a rename would make no run green.
  if (/^ {4}name:/m.test(jobBlock(text, 'native-adapter') ?? '') || !has(jobBlock(text, 'native-corpus-result') ?? '', `name: ${RECORD_JOBS[1]}`) || !/^ {4}name: Native corpus \(shard \$\{\{ matrix\.shard \}\}\/\d+\)$/m.test(jobBlock(text, 'native-corpus') ?? '')) {
    out.push(`${WORKFLOW}: the jobs must keep the names the coverage record reads: native-adapter (no name:), '${RECORD_JOBS[1]}', 'Native corpus (shard \${{ matrix.shard }}/N)'`);
  }
  if (!new RegExp(`^name: ${WORKFLOW_NAME.replace(/[()]/g, '\\$&')}$`, 'm').test(text)) out.push(`${WORKFLOW}: its name must stay '${WORKFLOW_NAME}'; ${BISECT_WORKFLOW} and the issue title follow it`);
  out.push(...bisectProblems(root));
  return out;
}

/** The bisect follows a red nightly, calls the lane at the probed commit, and may grant what the lane asks. */
function bisectProblems(root) {
  const path = join(root, BISECT_WORKFLOW);
  if (!existsSync(path)) return [`${BISECT_WORKFLOW} is missing; a red nightly would name no culprit`];
  const text = readFileSync(path, 'utf8');
  const out = [];
  if (!has(text, `workflows: ['${WORKFLOW_NAME}']`) || !has(text, 'types: [completed]')) out.push(`${BISECT_WORKFLOW}: must start on workflow_run of '${WORKFLOW_NAME}' (types: [completed])`);
  const probe = jobBlock(text, 'probe');
  if (probe === null || !has(probe, `uses: ./${WORKFLOW}`) || !has(probe, `bisect_sha: \${{ needs.plan.outputs.probe }}`)) {
    return [...out, `${BISECT_WORKFLOW}: the probe job must call ./${WORKFLOW} with bisect_sha: \${{ needs.plan.outputs.probe }}`];
  }
  const grant = permissionBlocks(probe, out, BISECT_WORKFLOW).find((b) => b.indent === 4)?.scopes ?? {};
  for (const { scopes } of workflowAsks(root, WORKFLOW, out)) {
    for (const [scope, level] of Object.entries(scopes)) {
      if (level !== 'none' && grant[scope] !== level && grant[scope] !== 'write') out.push(`${BISECT_WORKFLOW}: the probe job must grant ${scope}: ${level}; ${WORKFLOW} asks for it and GitHub refuses the run otherwise`);
    }
  }
  return out;
}
