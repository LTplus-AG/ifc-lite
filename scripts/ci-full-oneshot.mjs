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
 * nothing); a `pull_request` run that concluded `success`; an open PR from
 * the run's head repository whose head is still that run's head (a newer
 * head's own run decides); `ci:full` on the PR, applied before the run
 * was created; and a job from the fast lane's skip list that actually ran in
 * that run. The last two prove the label made the run full: a label added
 * while a run is going did not reach it, and taking it off then would cancel
 * the full pass the author just asked for. A docs-only PR whose path filter
 * skipped those jobs keeps its label, which is today's behaviour. Any
 * unreadable input keeps it too.
 *
 * WHY `success` ONLY. A failed run is not a full pass: when `build` fails, the
 * viewer, node and provenance lanes skip while `rust-retained` (which needs
 * only `changes`) still runs, so "a fast-skipped lane ran" would hold. A job
 * list cannot tell a dependency skip from a path-filter skip, so the run's own
 * verdict is the test: `success` means no lane failed or was cancelled, and
 * every skip was the path filter's. After a red full run the label stays, so
 * the author's next push gets the full lanes again.
 *
 *   node scripts/ci-full-oneshot.mjs --run   reads GITHUB_EVENT_PATH (workflow_run)
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { FAST_SKIPPED_JOBS, FULL_LABEL } from './ci-pr-lane.mjs';
import { gh as ghJson } from './lib/gh.mjs';
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
 * @param {{ mode?: string, prLane?: string, run: { event?: string, conclusion?: string, headSha?: string, createdAt?: string },
 *   pr: () => ({ number: number, state: string, headSha: string, labels: string[] } | null), jobs: () => object[],
 *   labeledAt: (number: number) => string | null }} input  `labeledAt`: when `ci:full` was last applied
 * @returns {{ action: 'remove'|'would-remove'|'keep', mode: string, reason: string, number?: number, warning?: string }}
 */
export function decideOneshot({ mode, prLane, run, pr, jobs, labeledAt }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'off' : raw;
  if (!MODES.includes(m)) return { action: 'keep', mode: 'off', reason: 'unknown CI_FULL_ONESHOT value', warning: `CI_FULL_ONESHOT=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; leaving labels alone` };
  const keep = (reason, extra = {}) => ({ action: 'keep', mode: m, reason, ...extra });
  if (m === 'off') return keep('CI_FULL_ONESHOT is unset or off');
  if (String(prLane ?? '').toLowerCase() !== 'fast') return keep(`CI_PR_LANE is not fast, so \`${FULL_LABEL}\` changes nothing`);
  if (run?.event !== 'pull_request') return keep(`the run was a ${run?.event || 'unknown'} run`);
  if (run?.conclusion !== 'success') return keep(`the run concluded ${run?.conclusion || 'unknown'}, not success, so it was not a full pass`);
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
  let applied;
  try {
    applied = Date.parse(labeledAt(p.number) ?? '');
  } catch (err) {
    return keep(`could not read when \`${FULL_LABEL}\` was applied (${err.message})`, { ...at, warning: `could not read the label history: ${err.message}` });
  }
  const created = Date.parse(run.createdAt ?? '');
  if (!(applied <= created)) return keep(`\`${FULL_LABEL}\` was applied after this run was created (or the times are unreadable), so it did not make this run full`, at);
  const why = `a full-lane run passed on the head of #${p.number}`;
  if (m === 'shadow') return { action: 'would-remove', mode: m, reason: why, ...at };
  return { action: 'remove', mode: m, reason: why, ...at };
}

/** The open PR this run's head belongs to, or null. */
function findPr(gh, repo, wr) {
  // The PR must come from the run's own head repository: a fork pushing
  // another PR's head SHA must not steer this decision.
  const headRepo = wr.head_repository?.full_name;
  const shape = (p) => (headRepo && p.head?.repo?.full_name === headRepo
    ? { number: p.number, state: p.state, headSha: p.head?.sha, labels: (p.labels ?? []).map((l) => l.name) }
    : null);
  // `pull_requests` can list PRs of other repos sharing the head branch.
  const linked = (wr.pull_requests ?? []).find((p) => p.head?.sha === wr.head_sha && String(p.base?.repo?.url ?? '').endsWith(`/repos/${repo}`))?.number;
  if (linked) return shape(gh(['api', `repos/${repo}/pulls/${linked}`], `PR #${linked}`));
  // A fork PR's run carries no `pull_requests`; find it by head branch.
  const owner = wr.head_repository?.owner?.login;
  if (!owner || !wr.head_branch) return null;
  const open = gh(['api', '-X', 'GET', `repos/${repo}/pulls`, '-f', 'state=open', '-f', `head=${owner}:${wr.head_branch}`], 'open PRs for the head branch');
  const hit = open.find((p) => p.head?.sha === wr.head_sha && p.head?.repo?.full_name === headRepo);
  return hit ? shape(hit) : null;
}

/** When `ci:full` was last applied to the PR, or null. */
function lastLabeledAt(gh, repo, number) {
  const events = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/events?per_page=100`], `#${number}'s label history`).flat();
  return events.filter((e) => e?.event === 'labeled' && e.label?.name === FULL_LABEL).at(-1)?.created_at ?? null;
}

/** A workflow-command value: `%`, CR and LF must be escaped or the annotation is cut. */
const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {(args: string[], what: string) => any} gh  runs `gh` and returns parsed JSON or throws (scripts/lib/gh.mjs)
 */
export function run(argv, env = process.env, gh = ghJson) {
  if (argv[0] !== '--run') throw new Error('--run is required');
  const repo = env.REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo))) throw new Error(`invalid REPO ${JSON.stringify(repo)}`);
  const wr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run ?? {};
  const d = decideOneshot({
    mode: env.CI_FULL_ONESHOT,
    prLane: env.CI_PR_LANE,
    run: { event: wr.event, conclusion: wr.conclusion, headSha: wr.head_sha, createdAt: wr.created_at },
    pr: () => findPr(gh, repo, wr),
    jobs: () => gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${wr.id}/jobs?filter=latest&per_page=100`], `run ${wr.id}'s jobs`).flatMap((page) => page.jobs ?? []),
    labeledAt: (n) => lastLabeledAt(gh, repo, n),
  });
  if (d.warning) console.log(`::warning::${escapeCommand(d.warning)}`);
  let line = `[ci-full-oneshot] ${d.action} (mode ${d.mode}): ${d.reason}`;
  if (d.action === 'remove') {
    try {
      gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${d.number}/labels/${encodeURIComponent(FULL_LABEL)}`], `the removal of ${FULL_LABEL}`);
    } catch (err) {
      // 404: already gone (the author or a parallel run took it off).
      if (!/HTTP 404|Label does not exist/i.test(err.message)) throw new Error(`could not remove ${FULL_LABEL} from #${d.number}: ${err.message}`);
    }
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
