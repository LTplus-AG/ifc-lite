#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lean lane for the Version Packages PR (`changeset-release/main`).
 *
 * WHY. changesets/action rewrites that PR after every merge to `main`, so it
 * had 183 `Test` runs on 170 heads in the week of 2026-11-04, about 100
 * runner-hours, almost all of it the full suite testing version bumps. Its
 * diff is package.json versions, CHANGELOGs, Cargo versions and deleted
 * changesets; no lane but the release-specific ones can say anything new.
 *
 * WHY IT IS SOUND. The PR reaches `main` only through Mergify's `release`
 * queue (.mergify.yml), which tests it on a `mergify/merge-queue/*` draft
 * (observed: draft #8727 for #8665). ci-pr-lane.mjs gives a batch branch the
 * full lanes, and the queue's merge conditions require `Viewer tests
 * (shard 0)` and `Rust tests (feature builds)`, which a lean run skips and
 * which `rust-full` runs on a pull_request only for a batch. So the queue,
 * not this run, is the full gate. `--decide` re-reads .mergify.yml and runs
 * full when that route is not there.
 *
 * THE SWITCH is the repo variable `CI_RELEASE_LANE`:
 *   unset / `off`  today's behaviour.
 *   `shadow`       every lane runs; the aggregate's summary lists what the
 *                  lean lane would have skipped and whether any of it failed.
 *   `on`           the release PR runs `changes` (late-changeset gate),
 *                  `rust-semver`, `silent-revert` and `release-pr` (changeset,
 *                  bump-level, Rust major-offset and README checks) and skips
 *                  the rest.
 * Any other value is `off`. Lean needs ALL of: a `pull_request` into `main`,
 * head ref exactly `changeset-release/main`, the head in this repository (a
 * fork's branch of that name runs full), the Mergify route above, and a diff
 * that only moves versions (`diffProblems`). Anything else runs full.
 *
 * FAIL CLOSED, BY POLARITY. `changes` withholds its path-filter outputs only
 * when this step printed exactly `lane=lean`; a crash, an empty or a garbled
 * output runs the path filter and every lane. The aggregate re-derives the
 * decision (`--verify`) and fails a lean run it cannot justify, because it
 * counts `skipped` as a pass.
 *
 *   node scripts/ci-release-lane.mjs --decide   `changes` job; writes lane/checks outputs
 *   node scripts/ci-release-lane.mjs --verify   aggregate; exit 1 on an unjustified lean run
 *
 * Inputs: GITHUB_EVENT_NAME, CI_RELEASE_LANE, HEAD_REF, HEAD_REPO, REPO,
 * BASE_REF; for --verify also LANE (the `changes` output) and NEEDS
 * (`toJSON(needs)`). Both read the PR's diff as `git diff HEAD~1 HEAD` on the
 * merge-ref checkout, so they need fetch-depth 2.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { isMainEntry } from './lib/is-main-entry.mjs';

export const RELEASE_HEAD_REF = 'changeset-release/main';
export const MODES = ['off', 'shadow', 'on'];

/** Jobs a lean run still runs. Every other job the aggregate needs is skipped. */
export const LEAN_KEPT_JOBS = ['changes', 'rust-semver', 'silent-revert', 'release-pr'];

/** The release queue must require these, or the queue is not the full gate. */
export const QUEUE_FULL_CHECKS = [
  'check-success=Build + WASM + Rust + Node',
  'check-success=Viewer tests (shard 0)',
  'check-success=Rust tests (feature builds)',
];

// `rust-version` (the MSRV) is not a version bump, hence the lookbehind.
const VERSION_VALUE = /(?<![\w-])version\s*=\s*"[^"]*"/g;

/**
 * Queue rules from .mergify.yml, read by indentation. Deliberately narrow:
 * anything it does not recognise yields no rule, which reads as "no route"
 * and runs full. The test pins it against a real YAML parse of the file.
 *
 * @param {string} text
 * @returns {{ name: string, queue: string[], merge: string[] }[]}
 */
export function parseQueueRules(text) {
  const rules = [];
  let inQueues = false;
  let rule = null;
  let list = null;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\S/.test(line)) {
      inQueues = /^queue_rules:\s*$/.test(line);
      rule = null;
      list = null;
      continue;
    }
    if (!inQueues) continue;
    let m = /^ {2}- name:\s*(\S.*?)\s*$/.exec(line);
    if (m) {
      rule = { name: m[1], queue: [], merge: [] };
      rules.push(rule);
      list = null;
      continue;
    }
    m = /^ {4}(queue_conditions|merge_conditions):\s*$/.exec(line);
    if (m && rule) {
      list = m[1] === 'queue_conditions' ? rule.queue : rule.merge;
      continue;
    }
    m = /^ {6}- (\S.*?)\s*$/.exec(line);
    if (m && list) {
      list.push(m[1]);
      continue;
    }
    if (/^ {4}\S/.test(line)) list = null;
  }
  return rules;
}

/** Does .mergify.yml route the release PR through a queue that runs the full gate? */
export function releaseQueueRoute(text) {
  const rule = parseQueueRules(text).find((r) => r.queue.includes(`head=${RELEASE_HEAD_REF}`));
  if (!rule) return { ok: false, reason: `no Mergify queue rule takes head=${RELEASE_HEAD_REF}` };
  const missing = QUEUE_FULL_CHECKS.filter((c) => !rule.merge.includes(c));
  if (missing.length > 0) return { ok: false, reason: `Mergify queue \`${rule.name}\` does not require ${missing.join(', ')}` };
  return { ok: true, reason: `Mergify queue \`${rule.name}\` gates the merge on the full lanes` };
}

/**
 * Only `version` may move. Internal dependencies use `workspace:` specifiers
 * and .changeset/config.json sets bumpVersionsWithWorkspaceProtocolOnly, so a
 * release never rewrites a dependency map.
 */
function onlyVersionsMoved(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const moved = [...keys].find((k) => k !== 'version' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return moved ? `\`${moved}\` changed` : null;
}

/**
 * Pairs every removed line with an added line in each hunk; a pair may differ
 * only in a `version = "..."` value, on a bare `version =` line (a package's
 * own version, or Cargo.lock's) or on a `path =` dependency (an internal
 * crate). A `checksum` change (an external crate moved in Cargo.lock), an
 * external requirement, `rust-version` or any other edit is a problem.
 */
function onlyCargoVersionsMoved(unifiedDiff) {
  const hunks = String(unifiedDiff).split(/^@@.*$/m).slice(1);
  for (const hunk of hunks) {
    const lines = hunk.split('\n');
    const minus = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const plus = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    if (minus.length !== plus.length) return 'lines were added or removed';
    for (let i = 0; i < minus.length; i++) {
      const internal = /^\s*version\s*=/.test(plus[i]) || /\bpath\s*=/.test(plus[i]);
      if (!internal || minus[i].replace(VERSION_VALUE, 'version=""') !== plus[i].replace(VERSION_VALUE, 'version=""')) return `\`${plus[i].trim()}\` is not a version change`;
    }
  }
  return null;
}

/**
 * What in the PR's diff is not a version bump. Empty means lean is allowed.
 *
 * @param {{ status: string, path: string }[]} entries  `git diff --name-status`
 * @param {{ show: (rev: string, path: string) => string, diff: (path: string) => string }} git
 * @returns {string[]}
 */
export function diffProblems(entries, git) {
  const problems = [];
  if (entries.length === 0) problems.push('the diff is empty or unreadable');
  for (const { status, path } of entries) {
    const name = basename(path);
    let problem = null;
    if (/^\.changeset\/[^/]+\.md$/.test(path) && name !== 'README.md') {
      if (status !== 'D') problem = 'a changeset may only be consumed (deleted)';
    } else if (name === 'CHANGELOG.md') {
      if (status !== 'M' && status !== 'A') problem = `status ${status}`;
      else {
        try {
          git.show('HEAD', path.replace(/CHANGELOG\.md$/, 'package.json'));
        } catch {
          problem = 'no package.json beside it, so changesets did not write it';
        }
      }
    } else if (name === 'package.json') {
      if (status !== 'M') problem = `status ${status}`;
      else {
        try {
          problem = onlyVersionsMoved(JSON.parse(git.show('HEAD~1', path)), JSON.parse(git.show('HEAD', path)));
        } catch (err) {
          problem = `unreadable (${err.message})`;
        }
      }
    } else if (name === 'Cargo.toml' || name === 'Cargo.lock') {
      problem = status === 'M' ? onlyCargoVersionsMoved(git.diff(path)) : `status ${status}`;
    } else {
      problem = 'not a release file';
    }
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

/**
 * Pure decision.
 *
 * @param {{ event?: string, mode?: string, headRef?: string, headRepo?: string, repo?: string, baseRef?: string,
 *   mergify?: () => string, diff?: () => string[] }} input  `mergify` and `diff` are read only when needed
 * @returns {{ lane: 'lean'|'full', mode: string, wouldBeLean: boolean, reason: string, warning?: string }}
 */
export function decideReleaseLane({ event, mode, headRef, headRepo, repo, baseRef, mergify, diff }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'off' : raw;
  const full = (reason, extra = {}) => ({ lane: 'full', mode: MODES.includes(m) ? m : 'off', wouldBeLean: false, reason, ...extra });
  if (!MODES.includes(m)) return full('unknown CI_RELEASE_LANE value', { warning: `CI_RELEASE_LANE=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; running the full lanes` });
  if (m === 'off') return full('CI_RELEASE_LANE is unset or off');
  if (headRef !== RELEASE_HEAD_REF) return full('not the release PR');
  if (event !== 'pull_request') return full(`${event || 'unknown event'} always runs the full lanes`);
  if (baseRef !== 'main') return full(`base is ${JSON.stringify(baseRef)}, not main`);
  if (!repo || headRepo !== repo) return full(`head is in ${JSON.stringify(headRepo)}, not this repository`);
  let route;
  try {
    route = releaseQueueRoute(mergify());
  } catch (err) {
    route = { ok: false, reason: `.mergify.yml unreadable (${err.message})` };
  }
  if (!route.ok) return full(`${route.reason}, so this run is the only gate`, { warning: `release lane refused: ${route.reason}` });
  let problems;
  try {
    problems = diff();
  } catch (err) {
    problems = [`diff unreadable (${err.message})`];
  }
  if (problems.length > 0) return full(`the diff is more than a version bump: ${problems.slice(0, 5).join('; ')}`);
  if (m === 'shadow') return { lane: 'full', mode: m, wouldBeLean: true, reason: 'shadow mode: full lanes run, lean lane reported' };
  return { lane: 'lean', mode: m, wouldBeLean: true, reason: `CI_RELEASE_LANE=on on the release PR; ${route.reason}` };
}

/**
 * The aggregate's check. A `lean` lane must re-derive as lean, the kept jobs
 * must exist and have succeeded: a skipped one would pass the aggregate's map.
 */
export function verifyReleaseLane(input) {
  const d = decideReleaseLane(input);
  let results;
  try {
    results = JSON.parse(input.needs ?? '');
  } catch {
    return { ok: false, lines: ['❌ NEEDS is not readable JSON; cannot tell which lanes ran.'] };
  }
  const unknown = LEAN_KEPT_JOBS.filter((j) => !(j in results));
  if (unknown.length > 0) return { ok: false, lines: [`❌ ci-release-lane.mjs names job(s) the aggregate does not need: ${unknown.join(', ')}. Update LEAN_KEPT_JOBS.`] };
  const resultOf = (j) => results[j]?.result ?? 'absent';
  const skippedByLean = Object.keys(results).filter((j) => !LEAN_KEPT_JOBS.includes(j));
  const listed = skippedByLean.map((j) => `- \`${j}\`: ${resultOf(j)}`);
  if (input.lane === 'lean') {
    if (d.lane !== 'lean') return { ok: false, lines: [`❌ UNJUSTIFIED_RELEASE_LANE: \`changes\` chose the lean lane but this run re-derives \`${d.lane}\` (${d.reason}). Skipped lanes are not a pass here.`] };
    // `skipped` passes the aggregate's map, so a kept job that did not run
    // would leave the lean run with no gate at all.
    const notRun = LEAN_KEPT_JOBS.filter((j) => resultOf(j) !== 'success');
    if (notRun.length > 0) return { ok: false, lines: [`❌ RELEASE_CHECKS_DID_NOT_PASS: a lean run needs every kept job to succeed: ${notRun.map((j) => `\`${j}\` was ${resultOf(j)}`).join(', ')}.`] };
    return { ok: true, lines: ['## Release PR lean lane (`CI_RELEASE_LANE=on`)', '', d.reason, '', 'Skipped on purpose; the `release` merge queue runs them:', '', ...listed] };
  }
  if (d.mode === 'shadow' && d.wouldBeLean) {
    const failed = skippedByLean.filter((j) => resultOf(j) === 'failure');
    const lines = ['## Release PR lean lane, shadow mode (`CI_RELEASE_LANE=shadow`)', '', 'Every lane ran. The lean lane would have skipped:', '', ...listed];
    lines.push('', failed.length > 0 ? `⚠️ The lean lane would have deferred a failure to the merge queue: ${failed.join(', ')}.` : 'None of them failed; the lean lane would have reached the same verdict.');
    return { ok: true, lines };
  }
  const lines = [`Release lane full: ${d.reason}.`];
  if (d.lane === 'lean') lines.push('⚠️ The decision re-derives as lean, but `changes` published no lean lane (the decision step failed or is missing), so every lane ran.');
  return { ok: true, lines };
}

function gitReader(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    entries: () => git(['diff', '--no-renames', '--name-status', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean).map((l) => {
      const [status, path] = l.split('\t');
      return { status: status[0], path };
    }),
    show: (rev, path) => git(['show', `${rev}:${path}`]),
    diff: (path) => git(['diff', '--no-renames', '-U0', 'HEAD~1', 'HEAD', '--', path]),
  };
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const git = gitReader(cwd);
  const input = {
    event: env.GITHUB_EVENT_NAME,
    mode: env.CI_RELEASE_LANE,
    headRef: env.HEAD_REF,
    headRepo: env.HEAD_REPO,
    repo: env.REPO,
    baseRef: env.BASE_REF,
    mergify: () => readFileSync(`${cwd}/.mergify.yml`, 'utf8'),
    diff: () => diffProblems(git.entries(), git),
  };
  if (argv[0] === '--decide') {
    const d = decideReleaseLane(input);
    if (d.warning) console.log(`::warning::${d.warning}`);
    console.log(`[ci-release-lane] lane=${d.lane} mode=${d.mode}: ${d.reason}`);
    if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set; refusing to decide into nowhere');
    appendFileSync(env.GITHUB_OUTPUT, `lane=${d.lane}\nchecks=${d.wouldBeLean}\n`);
    return 0;
  }
  if (argv[0] === '--verify') {
    const v = verifyReleaseLane({ ...input, lane: env.LANE, needs: env.NEEDS });
    for (const l of v.lines) console.log(l);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${v.lines.join('\n')}\n`);
    return v.ok ? 0 : 1;
  }
  throw new Error('one of --decide or --verify is required');
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-release-lane] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
