#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Push-to-main replay: skip re-testing a merge whose code the PR run already
 * tested byte for byte.
 *
 * Measured before this existed: in 57 of 97 merges `main` had not moved
 * between the PR's last green run and the merge, so the post-merge `Test` run
 * re-ran ~30 jobs on a tree it had already judged, and every one of those jobs
 * queued against the PRs still waiting for runners.
 *
 * THE EQUALITY IS EXACT, NOT INFERRED. A `pull_request` run checks out the
 * merge of the head into the base as it stood then, and GitHub records neither
 * that commit nor its tree anywhere the API exposes. So the PR run records it
 * itself: the `changes` job uploads an artifact NAMED `tested-tree-<tree>`.
 * The push replays only when a GREEN run of the merged PR's final head carries
 * the artifact for the exact tree the push commit has. A moved `main`, an
 * admin merge over a red or pending head, a re-pushed head, a squash that
 * resolved differently: all give a different tree or no green run, and the
 * push gets the full lane set.
 *
 *   node scripts/ci-push-replay.mjs --probe
 *       `changes` job, push events. Writes `replay=true|false` and
 *       `replay_run=<run id>` to $GITHUB_OUTPUT. Unreadable API evidence
 *       selects full validation; it never authorizes skipping a lane.
 *   node scripts/ci-push-replay.mjs --verify --run <id>
 *       Aggregate job, when `replay=true`. Re-reads the recorded run and
 *       refuses unless it is still a green run of this push's PR head with this
 *       push's tree artifact (a PR run re-run red in between must not pass).
 *
 * WHAT A REPLAY SKIPS is decided in test.yml, not here: only the lanes a PR
 * run executes. The push-only lanes (feature builds, census, CSG gates,
 * Plato) and the crates.io-dependent semver check still run and are judged.
 *
 * THE QUEUE ROUTE. With CI_PR_LANE=fast a PR run records no tree, and the full
 * gate is a Mergify batch PR. Mergify then merges each PR of the batch as its
 * own commit, seconds apart, and only the last commit has the batch's tree.
 * Measured on one 5-PR batch: 5 pushes x 387 job-minutes re-testing a ~425
 * job-minute run. So a push also replays when a green batch run of this
 * repository recorded the tree of this commit OR of a later commit on main:
 * that tree contains this commit, and it passed every lane. An earlier commit
 * of a batch is therefore never tested alone. Its own tree is not what `main`
 * ends on, and a probe that runs before its successor lands finds no evidence
 * and runs in full. A batch ran the push-only lanes too, so `replay_queue=true`
 * lets test.yml skip those as well.
 *
 * A commit touching NO_REPLAY paths also replays this way when each of those
 * files changes again in a later commit on main. The same file means the same
 * caches, and path filters run the same lanes: a later workflow-only full run
 * would not re-key what a Cargo.lock change needs. Only the newest runs in full.
 */

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { gh, GhError } from './lib/gh.mjs';
import { isBatchBranch } from './ci-pr-lane.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const TREE_ARTIFACT_PREFIX = 'tested-tree-';
export const TEST_WORKFLOW_FILE = 'test.yml';

/**
 * Paths whose change must still give `main` a full run although the code was
 * already tested: they key caches that ONLY a push to `main` writes (rust-cache
 * `save-if` main, the shared prefixes in test.yml and setup-wasm-build), so a
 * replay would leave every later PR restoring a stale or cold cache.
 */
const NO_REPLAY = [
  /^Cargo\.(lock|toml)$/,
  /(^|\/)Cargo\.toml$/,
  /^rust-toolchain\.toml$/,
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
];

const SHA = /^[0-9a-f]{40}$/;

/** More than one batch's worth of later commits; older evidence is not worth the reads. */
const MAX_LATER_COMMITS = 10;
const COMPARE_PAGE = 100;

/** The files main changed after a commit. A list that may be truncated counts as none: that only means a full run. */
export function laterFilesFrom(compare) {
  if (compare?.status !== 'ahead' || !Array.isArray(compare.files) || compare.files.length >= COMPARE_PAGE) return [];
  return compare.files.map((f) => f?.filename).filter((f) => typeof f === 'string');
}

const isTestWorkflow = (r) => r.path === undefined || r.path.endsWith(`/${TEST_WORKFLOW_FILE}`);
const newestFirst = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

/**
 * A green batch run of THIS repository. The repository check is what makes the
 * artifact evidence: a fork's `pull_request` run executes the fork's workflow,
 * so it could name a branch and an artifact after any tree it likes.
 */
const isGreenBatchRun = (r, repo) =>
  r &&
  r.event === 'pull_request' &&
  r.status === 'completed' &&
  r.conclusion === 'success' &&
  isTestWorkflow(r) &&
  isBatchBranch(r.head_branch) &&
  typeof repo === 'string' &&
  r.head_repository?.full_name === repo;

/**
 * Pure decision. Every input is something the probe read; nothing here calls
 * out, so the test drives each refusal directly.
 *
 * @param {{
 *   pushSha: string, pushTree: string, parentSha: string, before: string,
 *   changedFiles: string[],
 *   pulls: Array<{number: number, merged_at: string|null, merge_commit_sha: string|null, base: {ref: string}, head: {sha: string}}>,
 *   runs: Array<{id: number, head_sha: string, event: string, status: string, conclusion: string|null, path?: string, created_at: string}>,
 *   artifactNamesByRun: Record<string, string[]>,
 *   repo?: string,
 *   queueEvidence?: Array<{tree: string, runs: Array<object>}>,
 *   laterChangedFiles?: string[],
 * }} input `queueEvidence` lists this commit's tree, then later commits' trees, each with the runs holding its artifact.
 * @returns {{replay: true, runId: number, pr: number, queue?: true} | {replay: false, reason: string}}
 */
export function decidePushReplay(input) {
  const { pushSha, pushTree, parentSha, before, changedFiles, pulls, runs, artifactNamesByRun, repo, queueEvidence = [], laterChangedFiles = [] } = input;
  if (!SHA.test(pushSha ?? '') || !SHA.test(pushTree ?? '')) return { replay: false, reason: 'push SHA or tree is not a full hash' };
  // One squash commit on top of the previous tip. A multi-commit push (a
  // direct push, a rebase merge) is not the shape a single PR run tested.
  if (!SHA.test(before ?? '') || parentSha !== before) {
    return { replay: false, reason: `push is not a single commit on ${String(before).slice(0, 9)}` };
  }
  const keysCaches = (f) => NO_REPLAY.some((re) => re.test(f));
  const blocker = changedFiles.find(keysCaches);
  const blockerReason = `${blocker} changed; caches that only main writes must be re-keyed by a full run`;
  const rekeyedLater = changedFiles.filter(keysCaches).every((f) => laterChangedFiles.includes(f));
  if (blocker && !rekeyedLater) return { replay: false, reason: blockerReason };

  const merged = pulls.filter((p) => p && p.merged_at && p.merge_commit_sha === pushSha && p.base?.ref === 'main');
  if (merged.length !== 1) return { replay: false, reason: `${merged.length} merged PRs into main produced ${pushSha.slice(0, 9)}; need exactly one` };
  const pr = merged[0];
  const head = pr.head?.sha;
  if (!SHA.test(head ?? '')) return { replay: false, reason: `PR #${pr.number} has no head SHA` };

  const wanted = `${TREE_ARTIFACT_PREFIX}${pushTree}`;
  const green = runs
    .filter(
      (r) =>
        r &&
        r.event === 'pull_request' &&
        r.head_sha === head &&
        r.status === 'completed' &&
        r.conclusion === 'success' &&
        isTestWorkflow(r),
    )
    .sort(newestFirst);
  const hit = green.find((r) => (artifactNamesByRun[String(r.id)] ?? []).includes(wanted));
  if (hit && !blocker) return { replay: true, runId: hit.id, pr: pr.number };

  for (const { runs: treeRuns } of queueEvidence) {
    const proven = treeRuns.filter((r) => isGreenBatchRun(r, repo)).sort(newestFirst)[0];
    if (proven) return { replay: true, runId: proven.id, pr: pr.number, queue: true };
  }

  if (blocker) return { replay: false, reason: blockerReason };
  if (green.length === 0) return { replay: false, reason: `PR #${pr.number}'s final head ${head.slice(0, 9)} has no green Test run` };
  return { replay: false, reason: `no green Test run of PR #${pr.number} tested tree ${pushTree.slice(0, 9)} (main moved, or the run predates tree recording)` };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function emit(output, key, value) {
  if (output) appendFileSync(output, `${key}=${value}\n`);
  console.log(`  ${key}=${value}`);
}

function readInputs(repo, pushSha, pushTree, parentSha, before) {
  const changedFiles = git('diff', '--name-only', `${parentSha}`, pushSha).split('\n').filter(Boolean);
  const pulls = gh(['api', `repos/${repo}/commits/${pushSha}/pulls`, '--method', 'GET'], `the PRs of ${pushSha.slice(0, 9)}`);
  if (!Array.isArray(pulls)) throw new GhError('GH_BAD_SHAPE', 'commits/{sha}/pulls did not return an array');
  const merged = pulls.filter((p) => p?.merge_commit_sha === pushSha);
  const runs = [];
  const artifactNamesByRun = {};
  for (const p of merged) {
    if (typeof p.head?.sha !== 'string' || !SHA.test(p.head.sha)) {
      throw new GhError('GH_BAD_SHAPE', 'commits/{sha}/pulls item carried no valid head.sha');
    }
    const page = gh(
      ['api', `repos/${repo}/actions/workflows/${TEST_WORKFLOW_FILE}/runs?head_sha=${p.head.sha}&event=pull_request&status=success&per_page=30`, '--method', 'GET'],
      `the green Test runs of ${p.head.sha.slice(0, 9)}`,
    );
    if (!page || !Array.isArray(page.workflow_runs)) throw new GhError('GH_BAD_SHAPE', 'workflow runs response carried no workflow_runs array');
    for (const r of page.workflow_runs) {
      if (!r || !Number.isSafeInteger(r.id) || r.id <= 0) {
        throw new GhError('GH_BAD_SHAPE', 'workflow_runs item carried no valid run id');
      }
      runs.push(r);
      artifactNamesByRun[String(r.id)] = artifactNames(repo, r.id);
    }
  }
  const { queueEvidence, laterChangedFiles } = readQueueEvidence(repo, pushSha, pushTree);
  return { pushSha, pushTree, parentSha, before, changedFiles, pulls, runs, artifactNamesByRun, repo, queueEvidence, laterChangedFiles };
}

/** This commit's tree, then those of the commits main has gained since, each with the runs that recorded it. */
function readQueueEvidence(repo, pushSha, pushTree) {
  const compare = gh(
    ['api', `repos/${repo}/compare/${pushSha}...main?per_page=${COMPARE_PAGE}`, '--method', 'GET'],
    `the commits on main after ${pushSha.slice(0, 9)}`,
  );
  if (!compare || typeof compare.status !== 'string' || !Array.isArray(compare.commits)) {
    throw new GhError('GH_BAD_SHAPE', 'compare response carried no status or commits');
  }
  // A commit that is no longer an ancestor of main proves nothing about what main holds.
  const later = compare.status === 'ahead' ? compare.commits.slice(0, MAX_LATER_COMMITS) : [];
  const trees = later.map((c) => c?.commit?.tree?.sha);
  if (trees.some((tree) => typeof tree !== 'string' || !SHA.test(tree))) {
    throw new GhError('GH_BAD_SHAPE', 'compare commit carried no valid tree');
  }
  return { queueEvidence: [pushTree, ...trees].map((tree) => ({ tree, runs: runsThatRecorded(repo, tree) })), laterChangedFiles: laterFilesFrom(compare) };
}

function runsThatRecorded(repo, tree) {
  const name = `${TREE_ARTIFACT_PREFIX}${tree}`;
  const page = gh(
    ['api', `repos/${repo}/actions/artifacts?name=${name}&per_page=100`, '--method', 'GET'],
    `the runs that tested tree ${tree.slice(0, 9)}`,
  );
  if (!page || !Array.isArray(page.artifacts)) throw new GhError('GH_BAD_SHAPE', 'artifacts response carried no artifact list');
  const ids = new Set();
  for (const a of page.artifacts) {
    if (!a || typeof a.name !== 'string' || typeof a.expired !== 'boolean') {
      throw new GhError('GH_BAD_SHAPE', 'artifacts item carried no valid name or expiration flag');
    }
    if (a.name !== name || a.expired) continue;
    if (!Number.isSafeInteger(a.workflow_run?.id) || a.workflow_run.id <= 0) {
      throw new GhError('GH_BAD_SHAPE', 'artifact carried no valid workflow run');
    }
    ids.add(a.workflow_run.id);
  }
  return [...ids].map((id) => {
    const run = gh(['api', `repos/${repo}/actions/runs/${id}`, '--method', 'GET'], `Test run ${id}`);
    if (!run || run.id !== id) throw new GhError('GH_BAD_SHAPE', `run ${id} did not come back`);
    return run;
  });
}

function artifactNames(repo, runId) {
  const page = gh(
    ['api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, '--method', 'GET'],
    `the artifacts of run ${runId}`,
  );
  if (!page || !Array.isArray(page.artifacts)) throw new GhError('GH_BAD_SHAPE', 'artifacts response carried no artifacts array');
  if (page.artifacts.some((a) => !a || typeof a.name !== 'string' || typeof a.expired !== 'boolean')) {
    throw new GhError('GH_BAD_SHAPE', 'artifacts item carried no valid name or expiration flag');
  }
  return page.artifacts.filter((a) => !a.expired).map((a) => a.name);
}

export function run(argv, env = process.env) {
  const mode = argv.includes('--probe') ? 'probe' : argv.includes('--verify') ? 'verify' : null;
  if (!mode) throw new Error('one of --probe or --verify is required');
  const repo = env.GITHUB_REPOSITORY;
  const pushSha = env.GITHUB_SHA;
  if (!repo || !pushSha) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA are required');
  const pushTree = git('rev-parse', `${pushSha}^{tree}`);
  const parentSha = git('rev-parse', `${pushSha}^`);
  const before = env.PUSH_BEFORE ?? '';
  let decision;
  try {
    const inputs = readInputs(repo, pushSha, pushTree, parentSha, before);
    // --verify re-reads the run, not main's later history: a later revert must
    // not fail an aggregate whose replay the probe already chose correctly.
    if (mode === 'verify') inputs.laterChangedFiles = inputs.changedFiles;
    decision = decidePushReplay(inputs);
  } catch (err) {
    // The probe only saves work. Unreadable evidence must run the full suite,
    // not fail `changes` and suppress every dependent lane (#7944). Once a
    // replay was selected, --verify must still reject unreadable evidence.
    if (mode !== 'probe' || !(err instanceof GhError)) throw err;
    console.warn(`[push-replay] ${err.reason}: ${err.message}`);
    decision = { replay: false, reason: 'replay evidence could not be read; full validation is required' };
  }

  if (mode === 'probe') {
    if (decision.replay) {
      console.log(decision.queue
        ? `[push-replay] ${pushSha.slice(0, 9)} is contained in a tree that green merge-queue run ${decision.runId} tested. PR and push-only lanes skip.`
        : `[push-replay] ${pushSha.slice(0, 9)} is tree ${pushTree.slice(0, 9)}, which green run ${decision.runId} of PR #${decision.pr} already tested. PR lanes skip; push-only lanes run.`);
    } else {
      console.log(`[push-replay] full run: ${decision.reason}.`);
    }
    emit(env.GITHUB_OUTPUT, 'replay', decision.replay ? 'true' : 'false');
    emit(env.GITHUB_OUTPUT, 'replay_run', decision.replay ? String(decision.runId) : '');
    emit(env.GITHUB_OUTPUT, 'replay_queue', decision.queue ? 'true' : 'false');
    return 0;
  }

  const at = argv.indexOf('--run');
  const expected = at >= 0 ? argv[at + 1] : '';
  if (!decision.replay || String(decision.runId) !== String(expected)) {
    console.error(`[push-replay] REFUSING: the probe replayed run ${expected || '?'}, but re-reading now gives ${decision.replay ? `run ${decision.runId}` : decision.reason}. Re-run this workflow for a full verdict.`);
    return 2;
  }
  console.log(`[push-replay] ✔ run ${decision.runId} of PR #${decision.pr} is still a green run of tree ${pushTree.slice(0, 9)}.`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[push-replay] ${err instanceof GhError ? err.reason : 'ERROR'}: ${err.message}`);
    process.exitCode = 1;
  }
}
