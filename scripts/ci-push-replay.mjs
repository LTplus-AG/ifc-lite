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
 *       `replay_run=<run id>` to $GITHUB_OUTPUT. Exit 1 on an API failure, so
 *       the job goes red instead of guessing either way.
 *   node scripts/ci-push-replay.mjs --verify --run <id>
 *       Aggregate job, when `replay=true`. Re-reads the recorded run and
 *       refuses unless it is still a green run of this push's PR head with this
 *       push's tree artifact (a PR run re-run red in between must not pass).
 *
 * WHAT A REPLAY SKIPS is decided in test.yml, not here: only the lanes a PR
 * run executes. The push-only lanes (feature builds, census, CSG gates,
 * Plato) and the crates.io-dependent semver check still run and are judged.
 */

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { gh, GhError } from './lib/gh.mjs';
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
 * }} input
 * @returns {{replay: true, runId: number, pr: number} | {replay: false, reason: string}}
 */
export function decidePushReplay(input) {
  const { pushSha, pushTree, parentSha, before, changedFiles, pulls, runs, artifactNamesByRun } = input;
  if (!SHA.test(pushSha ?? '') || !SHA.test(pushTree ?? '')) return { replay: false, reason: 'push SHA or tree is not a full hash' };
  // One squash commit on top of the previous tip. A multi-commit push (a
  // direct push, a rebase merge) is not the shape a single PR run tested.
  if (!SHA.test(before ?? '') || parentSha !== before) {
    return { replay: false, reason: `push is not a single commit on ${String(before).slice(0, 9)}` };
  }
  const blocker = changedFiles.find((f) => NO_REPLAY.some((re) => re.test(f)));
  if (blocker) return { replay: false, reason: `${blocker} changed; caches that only main writes must be re-keyed by a full run` };

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
        (r.path === undefined || r.path.endsWith(`/${TEST_WORKFLOW_FILE}`)),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  if (green.length === 0) return { replay: false, reason: `PR #${pr.number}'s final head ${head.slice(0, 9)} has no green Test run` };
  const hit = green.find((r) => (artifactNamesByRun[String(r.id)] ?? []).includes(wanted));
  if (!hit) {
    return { replay: false, reason: `no green Test run of PR #${pr.number} tested tree ${pushTree.slice(0, 9)} (main moved, or the run predates tree recording)` };
  }
  return { replay: true, runId: hit.id, pr: pr.number };
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
    const page = gh(
      ['api', `repos/${repo}/actions/workflows/${TEST_WORKFLOW_FILE}/runs?head_sha=${p.head.sha}&event=pull_request&status=success&per_page=30`, '--method', 'GET'],
      `the green Test runs of ${p.head.sha.slice(0, 9)}`,
    );
    if (!page || !Array.isArray(page.workflow_runs)) throw new GhError('GH_BAD_SHAPE', 'workflow runs response carried no workflow_runs array');
    for (const r of page.workflow_runs) {
      runs.push(r);
      artifactNamesByRun[String(r.id)] = artifactNames(repo, r.id);
    }
  }
  return { pushSha, pushTree, parentSha, before, changedFiles, pulls, runs, artifactNamesByRun };
}

function artifactNames(repo, runId) {
  const page = gh(
    ['api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, '--method', 'GET'],
    `the artifacts of run ${runId}`,
  );
  if (!page || !Array.isArray(page.artifacts)) throw new GhError('GH_BAD_SHAPE', 'artifacts response carried no artifacts array');
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
  const decision = decidePushReplay(readInputs(repo, pushSha, pushTree, parentSha, before));

  if (mode === 'probe') {
    if (decision.replay) {
      console.log(`[push-replay] ${pushSha.slice(0, 9)} is tree ${pushTree.slice(0, 9)}, which green run ${decision.runId} of PR #${decision.pr} already tested. PR lanes skip; push-only lanes run.`);
    } else {
      console.log(`[push-replay] full run: ${decision.reason}.`);
    }
    emit(env.GITHUB_OUTPUT, 'replay', decision.replay ? 'true' : 'false');
    emit(env.GITHUB_OUTPUT, 'replay_run', decision.replay ? String(decision.runId) : '');
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
