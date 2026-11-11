#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-shot `ci:full`: after a full-lane `Test` run finishes on a PR's head,
 * take the label off so later pushes return to the fast lane.
 *
 * WHY. With CI_PR_LANE=fast, `ci:full` (scripts/ci-pr-lane.mjs) gives a PR
 * the full lanes, about 5.8 runner-hours a run against 0.7 for the fast
 * lane. The label stays on, so every later push pays again: 33 labelled PRs
 * made 281 runs in the week of 2026-11-04. The author re-applies the label
 * for another full pass; Test reads labels when a run is CREATED and has no
 * `labeled` trigger, so removing it starts nothing and the next push or a
 * close-and-reopen picks it up.
 *
 * THE SWITCH is the repo variable `CI_FULL_ONESHOT`:
 *   unset / `off`  today's behaviour; .github/workflows/ci-full-oneshot.yml
 *                  does not even start a job.
 *   `shadow`       decides, and writes "would remove" to the run summary.
 *   `on`           removes the label.
 * Any other value is `off`.
 *
 * FAIL CLOSED: only the exact decision `remove` touches the PR, and it needs
 * every one of: mode `on`; CI_PR_LANE `fast` (otherwise the label changes
 * nothing); a `pull_request` run that concluded `success` or `failure` (not
 * cancelled, not skipped); an open PR whose head is still that run's head (a
 * newer head's own run decides); `ci:full` on the PR; and a job from the fast
 * lane's skip list that actually ran in that run. The last one is the proof
 * the run was full: a run created before the label was added ran the fast
 * lane, and taking the label off then would cancel the full pass the author
 * just asked for. A docs-only PR whose path filter skipped those jobs keeps
 * its label, which is today's behaviour. Any unreadable input keeps it too.
 *
 *   node scripts/ci-full-oneshot.mjs --run   reads GITHUB_EVENT_PATH (workflow_run)
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { FAST_SKIPPED_JOBS, FULL_LABEL } from './ci-pr-lane.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const MODES = ['off', 'shadow', 'on'];

/**
 * The published check-run name of each job in FAST_SKIPPED_JOBS, as a prefix
 * (matrix legs append their shard). The test pins this against test.yml.
 */
export const FAST_SKIPPED_JOB_NAMES = {
  'viewer-tests': 'Viewer tests (shard ',
  'viewer-e2e': 'Viewer E2E smoke (',
  'node-tests': 'Node tests (shard ',
  'provenance-tests': 'Provenance tests',
  'rust-retained': 'Rust tests (retained)',
};

const FINISHED = ['success', 'failure'];

/** Did any fast-skipped job really run (not skipped, not absent) in this run? */
export function ranFullLane(jobs) {
  if (!Array.isArray(jobs)) return false;
  const prefixes = FAST_SKIPPED_JOBS.map((k) => FAST_SKIPPED_JOB_NAMES[k]);
  return jobs.some((j) => typeof j?.name === 'string' && prefixes.some((p) => j.name.startsWith(p)) && j.conclusion && j.conclusion !== 'skipped');
}

/**
 * Pure decision. `pr` and `jobs` are functions so the caller only spends an
 * API call once the cheaper checks have passed.
 *
 * @param {{ mode?: string, prLane?: string, run: { event?: string, conclusion?: string, headSha?: string },
 *   pr: () => ({ number: number, state: string, headSha: string, labels: string[] } | null), jobs: () => object[] }} input
 * @returns {{ action: 'remove'|'would-remove'|'keep', mode: string, reason: string, number?: number, warning?: string }}
 */
export function decideOneshot({ mode, prLane, run, pr, jobs }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'off' : raw;
  if (!MODES.includes(m)) return { action: 'keep', mode: 'off', reason: 'unknown CI_FULL_ONESHOT value', warning: `CI_FULL_ONESHOT=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; leaving labels alone` };
  const keep = (reason, extra = {}) => ({ action: 'keep', mode: m, reason, ...extra });
  if (m === 'off') return keep('CI_FULL_ONESHOT is unset or off');
  if (String(prLane ?? '').toLowerCase() !== 'fast') return keep(`CI_PR_LANE is not fast, so \`${FULL_LABEL}\` changes nothing`);
  if (run?.event !== 'pull_request') return keep(`the run was a ${run?.event || 'unknown'} run`);
  if (!FINISHED.includes(run?.conclusion)) return keep(`the run concluded ${run?.conclusion || 'unknown'}`);
  let p;
  try {
    p = pr();
  } catch (err) {
    return keep(`could not read the PR (${err.message})`, { warning: `could not read the PR: ${err.message}` });
  }
  if (!p) return keep('no open PR has this head');
  const at = { number: p.number };
  if (p.state !== 'open') return keep(`#${p.number} is ${p.state}`, at);
  if (!run.headSha || p.headSha !== run.headSha) return keep(`#${p.number} has moved to a newer head; that head's run decides`, at);
  if (!Array.isArray(p.labels) || !p.labels.includes(FULL_LABEL)) return keep(`#${p.number} does not carry \`${FULL_LABEL}\``, at);
  let list;
  try {
    list = jobs();
  } catch (err) {
    return keep(`could not read the run's jobs (${err.message})`, { ...at, warning: `could not read the run's jobs: ${err.message}` });
  }
  if (!ranFullLane(list)) return keep(`no fast-skipped lane ran in this run, so it was not a full-lane run (the label may have arrived after it started)`, at);
  const why = `a full-lane run ${run.conclusion === 'success' ? 'passed' : 'failed'} on the head of #${p.number}`;
  if (m === 'shadow') return { action: 'would-remove', mode: m, reason: why, ...at };
  return { action: 'remove', mode: m, reason: why, ...at };
}

function ghCli(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ghJson(gh, args) {
  const r = gh(args);
  if (r.status !== 0) throw new Error(String(r.stderr || `gh exit ${r.status}`).trim());
  return JSON.parse(r.stdout);
}

/** The open PR this run's head belongs to, or null. */
function findPr(gh, repo, wr) {
  const shape = (p) => ({ number: p.number, state: p.state, headSha: p.head?.sha, labels: (p.labels ?? []).map((l) => l.name) });
  const linked = wr.pull_requests?.[0]?.number;
  if (linked) return shape(ghJson(gh, ['api', `repos/${repo}/pulls/${linked}`]));
  // A fork PR's run carries no `pull_requests`; find it by head branch.
  const owner = wr.head_repository?.owner?.login;
  if (!owner || !wr.head_branch) return null;
  const open = ghJson(gh, ['api', '-X', 'GET', `repos/${repo}/pulls`, '-f', 'state=open', '-f', `head=${owner}:${wr.head_branch}`]);
  const hit = open.find((p) => p.head?.sha === wr.head_sha);
  return hit ? shape(hit) : null;
}

export function run(argv, env = process.env, gh = ghCli) {
  if (argv[0] !== '--run') throw new Error('--run is required');
  const repo = env.REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo))) throw new Error(`invalid REPO ${JSON.stringify(repo)}`);
  const wr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run ?? {};
  const d = decideOneshot({
    mode: env.CI_FULL_ONESHOT,
    prLane: env.CI_PR_LANE,
    run: { event: wr.event, conclusion: wr.conclusion, headSha: wr.head_sha },
    pr: () => findPr(gh, repo, wr),
    jobs: () => ghJson(gh, ['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${wr.id}/jobs?filter=latest&per_page=100`]).flatMap((page) => page.jobs ?? []),
  });
  if (d.warning) console.log(`::warning::${d.warning}`);
  let line = `[ci-full-oneshot] ${d.action} (mode ${d.mode}): ${d.reason}`;
  if (d.action === 'remove') {
    const r = gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${d.number}/labels/${encodeURIComponent(FULL_LABEL)}`]);
    // 404: already gone (the author or a parallel run took it off).
    if (r.status !== 0 && !/HTTP 404|Label does not exist/i.test(String(r.stderr))) throw new Error(`could not remove ${FULL_LABEL} from #${d.number}: ${String(r.stderr).trim()}`);
    line = `${line}. Removed \`${FULL_LABEL}\` from #${d.number}; re-apply it for another full pass.`;
  } else if (d.action === 'would-remove') {
    line = `${line}. Shadow mode: would remove \`${FULL_LABEL}\` from #${d.number}.`;
  }
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  return d;
}

if (isMainEntry(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-full-oneshot] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
