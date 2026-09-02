#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SIGNAL for issue #3726: CI certifies a PR against a base that then moves, so
 * two individually-green PRs can merge into a red `main`.
 *
 * `main` sat red on the module-size ratchet for ~4 hours because three merges
 * composed: #3668 grew three files under `scripts/review/`, #3689 then
 * re-recorded `scripts/module-size-allowlist.txt` from a tree that predated
 * #3668, and #3686 grew four more on top. Each PR's lane was green against its
 * own base. Nothing re-checked the base after it moved.
 *
 * ## Why this is a display and not a gate
 *
 * Measured 2026-09-02T21:58Z over all 55 then-open PRs, every one of them was
 * behind `origin/main`: 3, 6 (x8), 7 (x2), 17 (x5), 18 (x3), 19 (x8), 21 (x17),
 * 51, 74, 79, 81, 83 (x2), 89, 90, 201, 222, 1529. Median 21. NOT ONE was
 * current. So "your base has moved" is true of every PR at every moment and
 * carries no information: enforcing on it -- GitHub's `strict_required_status
 * _checks_policy`, which the `main` ruleset has OFF -- would demand a rebase
 * and a full re-run of every open PR after every merge, and this repo merges
 * ~15 times a day. The measurement is what rules that out, not taste.
 *
 * What DOES carry information is the narrow case the incident was made of: a
 * COMMITTED WHOLE-TREE SNAPSHOT recorded on one side of the move and
 * invalidated by the other. Those are the gates that cannot be re-derived from
 * the merged tree alone, because a snapshot is a measurement of a tree that no
 * longer exists. So this fires only when the PR and main's new commits are
 * coupled through one -- see `evaluateFreshness` in
 * `scripts/lib/base-freshness.mjs`.
 *
 * ## What it deliberately does NOT catch
 *
 * - The #2551/#2538 class in `test.yml`'s own header: a helper deleted in one
 *   PR and a caller added in another. No snapshot is involved, so nothing here
 *   couples them. Only a merge queue re-running the suite on the post-merge
 *   tree catches that, and that is the issue's option 1.
 * - Directory-granular baselines (`scripts/unused-locals-baseline.json` pins
 *   per-package counts). Their input set is a whole package, so coupling on
 *   them degenerates to the blanket enforcement the measurement rules out.
 * - The exact tree CI built. GitHub does not expose the merge commit a run
 *   checked out, so the tested base is read from the check-suite and falls back
 *   to the merge-base, which over-reports rather than under-reports.
 *
 * ## Run
 *
 *   node scripts/check-base-freshness.mjs --pr 3689     # one PR, exit 1 if STALE
 *   node scripts/check-base-freshness.mjs --all --label # sweep, label the stale ones
 *   node scripts/check-base-freshness.mjs --from-json f # replay a recorded case offline
 *
 * The sweep runs on `push: main` (`.github/workflows/base-freshness.yml`),
 * because a merge landing is the only moment a PR's verdict can go stale.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  discoverSnapshots,
  evaluateFreshness,
  formatVerdict,
  rowsChangedInPatch,
} from './lib/base-freshness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STALE_LABEL = 'base-stale';

/**
 * A snapshot count below this means the discovery scan stopped seeing the tree
 * -- a moved `scripts/`, a changed extension, a regex that stopped matching --
 * and the sweep would then pass by examining nothing. Three checks in this repo
 * have shipped exiting 0 having examined nothing; this one refuses to.
 */
const SNAPSHOT_FLOOR = 3;

/**
 * GitHub's compare endpoint returns at most 250 commits and will not show more
 * of the diff than that. Its FILE list paginates, so that cap is the only one
 * left -- and past it the comparison under-reports, which reads as OK. A branch
 * this far back needs a rebase before any of this is the interesting question,
 * so it is reported STALE rather than quietly compared against a partial view.
 */
const COMPARE_COMMIT_CAP = 250;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghJson(path) {
  return JSON.parse(gh(['api', path]));
}

function isRepoFile(p) {
  const full = resolve(REPO_ROOT, p);
  if (!full.startsWith(REPO_ROOT)) return false;
  try {
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

function loadSnapshots() {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  const snapshots = discoverSnapshots({
    trackedFiles: tracked,
    readFile: (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8'),
    isRepoFile,
  });

  if (snapshots.length < SNAPSHOT_FLOOR) {
    console.error(
      `check-base-freshness: found only ${snapshots.length} whole-tree snapshot(s), expected at least ${SNAPSHOT_FLOOR}.\n` +
        'The discovery scan has stopped seeing the tree; a sweep now would pass by examining nothing.'
    );
    process.exit(2);
  }
  return snapshots;
}

/** The base the PR's checks actually ran against, best-effort. */
function testedBase(repo, pr, mainTip) {
  try {
    const runs = ghJson(`repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`);
    for (const run of runs.check_runs ?? []) {
      const base = run.pull_requests?.[0]?.base?.sha;
      if (base) return { sha: base, source: 'check-suite' };
    }
  } catch {
    // Falls through to the merge-base, which over-reports rather than hides.
  }
  const cmp = ghJson(`repos/${repo}/compare/${mainTip}...${pr.headRefOid}`);
  return { sha: cmp.merge_base_commit.sha, source: 'merge-base' };
}

function prChangedFiles(repo, number) {
  return gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    '--jq',
    '.[].filename',
  ])
    .split('\n')
    .filter(Boolean);
}

/** Every file main changed since `base`, with the patch for the snapshots. */
function movedSince(repo, base, mainTip) {
  return gh([
    'api',
    '--paginate',
    `repos/${repo}/compare/${base}...${mainTip}?per_page=100`,
    '--jq',
    '.files[] | {filename, patch}',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function evaluatePr(repo, pr, mainTip, snapshots) {
  const base = testedBase(repo, pr, mainTip);
  const meta = ghJson(`repos/${repo}/compare/${base.sha}...${mainTip}?per_page=1`);
  const commitsBehind = meta.ahead_by ?? 0;

  if (commitsBehind > COMPARE_COMMIT_CAP) {
    return {
      pr: pr.number,
      baseSha: base.sha,
      baseSource: base.source,
      commitsBehind,
      movedFileCount: 0,
      result: {
        stale: true,
        couplings: [{ snapshot: null, direction: 'truncated', overlap: [] }],
      },
    };
  }

  const moved = movedSince(repo, base.sha, mainTip);
  const movedFiles = moved.map((f) => f.filename);

  // The compare response already carries each changed file's patch, so row
  // granularity for the snapshots main touched costs no extra request.
  const rowsChangedOnMain = new Map();
  const snapshotPaths = new Set(snapshots.map((s) => s.path));
  for (const file of moved) {
    if (!snapshotPaths.has(file.filename) || !file.patch) continue;
    rowsChangedOnMain.set(file.filename, rowsChangedInPatch(file.patch, isRepoFile));
  }

  const prFiles = prChangedFiles(repo, pr.number);
  return {
    pr: pr.number,
    baseSha: base.sha,
    baseSource: base.source,
    commitsBehind,
    movedFileCount: movedFiles.length,
    result: evaluateFreshness({ prFiles, movedFiles, snapshots, rowsChangedOnMain }),
  };
}

function syncLabel(repo, number, stale) {
  try {
    if (stale) {
      gh([
        'api',
        `repos/${repo}/issues/${number}/labels`,
        '--method',
        'POST',
        '-f',
        `labels[]=${STALE_LABEL}`,
        '--silent',
      ]);
    } else {
      gh([
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

function summarize(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${lines.join('\n\n')}\n`);
}

function parseArgs(argv) {
  const opts = { all: false, pr: null, label: false, fromJson: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--label') opts.label = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--pr') opts.pr = Number(argv[++i]);
    else if (arg === '--from-json') opts.fromJson = argv[++i];
    else {
      console.error(`check-base-freshness: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const snapshots = loadSnapshots();

  // Replay mode: evaluate a recorded case with no network. This is how the
  // #3726 incident itself is regression-tested, and how a live verdict can be
  // reproduced later from the numbers printed with it.
  if (opts.fromJson) {
    const input = JSON.parse(readFileSync(opts.fromJson, 'utf8'));
    const result = evaluateFreshness({
      prFiles: input.prFiles ?? [],
      movedFiles: input.movedFiles ?? [],
      snapshots: input.snapshots
        ? input.snapshots.map((s) => ({ path: s.path, inputs: new Set(s.inputs) }))
        : snapshots,
      rowsChangedOnMain: new Map(
        Object.entries(input.rowsChangedOnMain ?? {}).map(([k, v]) => [k, new Set(v)])
      ),
    });
    const verdict = formatVerdict({
      pr: input.pr ?? 0,
      baseSha: input.baseSha ?? null,
      commitsBehind: input.commitsBehind ?? 0,
      movedFileCount: (input.movedFiles ?? []).length,
      result,
    });
    console.log(opts.json ? JSON.stringify({ ...result, verdict }) : verdict);
    process.exit(result.stale ? 1 : 0);
  }

  const repo = process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const mainTip = ghJson(`repos/${repo}/commits/main`).sha;

  if (opts.pr) {
    const pr = ghJson(`repos/${repo}/pulls/${opts.pr}`);
    const report = evaluatePr(
      repo,
      { number: pr.number, headRefOid: pr.head.sha },
      mainTip,
      snapshots
    );
    const verdict = formatVerdict(report);
    console.log(opts.json ? JSON.stringify({ ...report, verdict }) : verdict);
    process.exit(report.result.stale ? 1 : 0);
  }

  if (!opts.all) {
    console.error('check-base-freshness: pass --pr <n>, --all, or --from-json <file>.');
    process.exit(2);
  }

  // NDJSON, one PR per line: `--jq` and `--slurp` are mutually exclusive in gh.
  const open = gh([
    'api',
    '--paginate',
    `repos/${repo}/pulls?state=open&per_page=100`,
    '--jq',
    '.[] | {number, headRefOid: .head.sha}',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  console.log(
    `check-base-freshness: main at ${mainTip.slice(0, 9)}, ${snapshots.length} whole-tree snapshot(s), ${open.length} open PR(s).`
  );

  const stale = [];
  const summaryLines = [];
  let displayFailures = 0;
  for (const pr of open) {
    let report;
    try {
      report = evaluatePr(repo, pr, mainTip, snapshots);
    } catch (err) {
      console.error(`check-base-freshness: PR #${pr.number} could not be evaluated: ${err.message}`);
      displayFailures += 1;
      continue;
    }
    const verdict = formatVerdict(report);
    console.log(verdict);
    if (report.result.stale) {
      stale.push(report.pr);
      summaryLines.push(verdict);
    }
    if (opts.label && !syncLabel(repo, pr.number, report.result.stale)) displayFailures += 1;
  }

  console.log(`check-base-freshness: ${stale.length} of ${open.length} open PR(s) STALE.`);
  if (summaryLines.length > 0) summarize(summaryLines);

  // The sweep is a display, so a stale PR is not a failure of the sweep. Being
  // UNABLE to display is: a label that never landed is indistinguishable from a
  // clean PR to whoever reads the list before merging.
  process.exit(displayFailures > 0 ? 1 : 0);
}

main();
