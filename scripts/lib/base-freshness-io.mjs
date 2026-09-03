/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every read and write `check-base-freshness.mjs` makes against git and
 * GitHub, split out so the gate itself is the verdict logic and this is the
 * I/O it runs on. Split for the 400-line rule (#3726 review), and the seam is
 * the one that was already implicit: `evaluateFreshness` in
 * `lib/base-freshness.mjs` is pure, this module is entirely effects, and the
 * gate in between orchestrates the two.
 *
 * THE DIFFS COME FROM LOCAL GIT, NOT FROM GITHUB'S `compare`. That endpoint
 * caps its `files` array at 300 (measured: PR #3610's base returned exactly
 * 300 where the real diff is 585) and drops it entirely past 250 commits.
 * `--paginate` does not lift the cap. Reading it that way made a coupling past
 * file 300 invisible while the verdict printed OK, which is the silent miss
 * this whole gate exists to prevent.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gh as ghJson } from './gh.mjs';
import { rowsChangedInPatch } from './base-freshness.mjs';

// This module lives in scripts/lib/, so the repo root is two levels up rather
// than one. Computed here rather than passed in: every git call in this file
// runs against the repository this file is part of, and threading it through
// eight signatures would invite a caller to point them somewhere else.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STALE_LABEL = 'base-stale';

/**
 * Raw `gh` stdout, for the three reads `lib/gh.mjs` cannot serve: it always
 * `JSON.parse`s, and these want the text. Two are `--jq` NDJSON walks (one
 * object per line, because `--jq` and `--slurp` are mutually exclusive in gh)
 * and the third is a `--silent` label write whose stdout is empty by design.
 * Every JSON read here goes through the shared invoker instead.
 */
export function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

export function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Refuse to run against a checkout that is not main.
 *
 * `mainTip` is the checkout's HEAD, which on `push: main` is the commit that
 * triggered the run. From anywhere else it is a lie with a confident verdict
 * attached. Measured on PR #3710, which is STALE on main: from the PR's branch
 * tip it reads "OK, main has gained 4 commit(s)"; from a checkout at the PR's
 * own base, "OK, 0 commit(s)"; from a checkout 30 commits older, "STALE, 0
 * commit(s) touching 209 file(s)", citing a snapshot out of a REVERSED diff.
 * Three different answers, none of them flagged as suspect.
 *
 * This matters in CI and not only locally: the workflow carries
 * `workflow_dispatch`, and its concurrency group is keyed on `github.ref`, so a
 * dispatch on a feature branch runs `--all --label` alongside main's own sweep
 * and DELETEs correct `base-stale` labels on its way through.
 */
export function resolveMainTip(repo) {
  // `refs/remotes/origin/main` first, so a run from a feature branch still
  // measures against main. HEAD is the fallback for the sweep's own checkout,
  // where `push: main` means HEAD IS main and a remote-tracking ref may not
  // have been created.
  let tip;
  try {
    tip = git(['rev-parse', 'refs/remotes/origin/main']).trim();
  } catch {
    tip = git(['rev-parse', 'HEAD']).trim();
  }

  // Whichever it came from, it must actually BE main, and that is checked
  // against the API rather than assumed. A local ref can be stale by days.
  const remote = ghJson(['api', `repos/${repo}/commits/main`], "main's tip").sha;
  if (tip === remote) return tip;
  console.error(
    `check-base-freshness: the local main this run would measure against is ${tip.slice(0, 9)}, ` +
      `but ${repo}'s main is at ${remote.slice(0, 9)}. Every diff here comes from the local ` +
      'object database, so measuring against the wrong tree produces a verdict that is wrong ' +
      'with full confidence -- one PR read OK, OK and STALE from three different checkouts. ' +
      'Run `git fetch origin main` and try again.'
  );
  process.exit(2);
}

/** Is this commit in the local object database? */
export function haveCommit(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** The base the PR's checks actually ran against, best-effort. */
export function testedBase(repo, pr, mainTip) {
  try {
    const runs = ghJson(
      ['api', `repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`],
      `the check runs on PR #${pr.number}'s head`,
    );
    for (const run of runs.check_runs ?? []) {
      const base = run.pull_requests?.[0]?.base?.sha;
      if (base) return { sha: base, source: 'check-suite' };
    }
  } catch {
    // Falls through to the merge-base, which over-reports rather than hides.
  }
  const cmp = ghJson(
    ['api', `repos/${repo}/compare/${mainTip}...${pr.headRefOid}`],
    `the merge base of PR #${pr.number} and main`,
  );
  return { sha: cmp.merge_base_commit.sha, source: 'merge-base' };
}

/**
 * The PR's changed files, plus the rows it moved in each snapshot it touches.
 *
 * The rows cost NOTHING extra: `pulls/:n/files` already returns each file's
 * `patch`, and this used to discard it. Asking for it is what lets the
 * `pr-recorded` direction be row-granular instead of whole-file -- see the
 * measurement in `evaluateFreshness`.
 */
export function prChanges(repo, number, snapshotPaths, isRepoFile) {
  const rows = ghText([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    '--jq',
    '.[] | {filename, patch}',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const prFiles = rows.map((f) => f.filename);
  const rowsChangedInPr = new Map();
  for (const f of rows) {
    // A snapshot big enough for GitHub to omit `patch` falls through to the
    // whole pinned set, which over-reports. That direction is visible and
    // arguable; an omission would be neither.
    if (!snapshotPaths.has(f.filename) || !f.patch) continue;
    rowsChangedInPr.set(f.filename, rowsChangedInPatch(f.patch, isRepoFile));
  }
  return { prFiles, rowsChangedInPr };
}

/**
 * Every file main changed since `base`, plus the rows moved in each snapshot.
 *
 * Read from local git, so there is no 300-file cap and no 250-commit cliff. The
 * per-snapshot patch is asked for only for paths that ARE snapshots, which is a
 * handful, and `-U0` keeps it to the changed rows.
 */
export function movedSince(base, mainTip, snapshotPaths, isRepoFile) {
  const movedFiles = git(['diff', '--name-only', `${base}..${mainTip}`])
    .split('\n')
    .filter(Boolean);

  const rowsChangedOnMain = new Map();
  for (const path of movedFiles) {
    if (!snapshotPaths.has(path)) continue;
    const patch = git(['diff', '-U0', `${base}..${mainTip}`, '--', path]);
    rowsChangedOnMain.set(path, rowsChangedInPatch(patch, isRepoFile));
  }
  return { movedFiles, rowsChangedOnMain };
}

export function syncLabel(repo, number, stale) {
  try {
    if (stale) {
      ghText([
        'api',
        `repos/${repo}/issues/${number}/labels`,
        '--method',
        'POST',
        '-f',
        `labels[]=${STALE_LABEL}`,
        '--silent',
      ]);
    } else {
      ghText([
        'api',
        `repos/${repo}/issues/${number}/labels/${STALE_LABEL}`,
        '--method',
        'DELETE',
        '--silent',
      ]);
    }
    return true;
  } catch (err) {
    // DELETE on a PR that never carried the label is a 404 and is not a
    // failure. Anything else -- a missing `pull-requests: write`, a rate limit
    // -- is, and must not read as "nothing to display".
    const body = `${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`;
    return !stale && /HTTP 404/.test(body);
  }
}
