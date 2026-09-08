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
  formatSweepSummary,
  formatVerdict,
  rowsChangedInPatch,
} from './lib/base-freshness.mjs';
import { gh as ghJson } from './lib/gh.mjs';
import {
  ghText,
  git,
  haveCommit,
  movedSince,
  prChanges,
  resolveMainTip,
  syncLabel,
  testedBase,
} from './lib/base-freshness-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

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
 * WHY THE MOVED-FILE SET COMES FROM LOCAL GIT AND NOT FROM `compare`.
 *
 * An earlier draft read it from `repos/:o/:r/compare/base...main` and was wrong
 * in two ways at once, one loud and one silent. Measured 2026-09-03 on PR
 * #3610's base (107 commits behind): the response carries `files` with EXACTLY
 * 300 entries. 300 is the endpoint's hard cap on that array and `--paginate`
 * does not lift it -- an earlier comment here asserted the file list paginates,
 * and that claim was simply false. Past 300 files the comparison UNDER-reports,
 * a coupling beyond the cap is invisible, and the verdict prints OK. That is
 * the silent miss this whole script exists to avoid, arriving through its own
 * front door.
 *
 * The loud half: over 250 commits GitHub drops `files` entirely, `--jq
 * '.files[]'` fails with "cannot iterate over: null", and the PR gets no
 * verdict at all. 7 of 36 open PRs came back that way in the first live sweep.
 *
 * The sweep runs on `push: main` with the repository already checked out, so
 * the local object database answers the same question exactly, with no cap, no
 * pagination and no request. The workflow therefore checks out with
 * `fetch-depth: 0`; a base commit that is somehow still absent is reported as
 * its own outcome rather than being quietly treated as "nothing moved".
 */

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
  const tracked = git(['ls-files']).split('\n').filter(Boolean);

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

function evaluatePr(repo, pr, mainTip, snapshots) {
  const base = testedBase(repo, pr, mainTip);

  // A base we do not have locally cannot be diffed, and "no diff" is
  // indistinguishable from "nothing moved" once it reaches the verdict. So it
  // is its own outcome, named, rather than an OK nobody can audit.
  if (!haveCommit(base.sha)) {
    // Routed to the SAME unevaluated outcome as any other failure to look,
    // rather than being reported STALE. Labelling a PR because this checkout
    // is shallow blames the PR for the sweep's depth: from a `--depth 1`
    // clone every PR came back STALE and was told to "rebase and re-record",
    // which is advice about the wrong repository.
    throw new Error(
      `its tested base ${base.sha.slice(0, 9)} is not in this checkout, so no diff could be ` +
        'taken -- deepen the checkout (fetch-depth: 0) or rebase the PR'
    );
  }

  const commitsBehind = Number(
    git(['rev-list', '--count', `${base.sha}..${mainTip}`]).trim()
  );

  const snapshotPaths = new Set(snapshots.map((s) => s.path));
  const { movedFiles, rowsChangedOnMain } = movedSince(base.sha, mainTip, snapshotPaths, isRepoFile);

  const { prFiles, rowsChangedInPr } = prChanges(repo, pr.number, snapshotPaths, isRepoFile);
  return {
    pr: pr.number,
    baseSha: base.sha,
    commitsBehind,
    movedFileCount: movedFiles.length,
    result: evaluateFreshness({
      prFiles,
      movedFiles,
      snapshots,
      rowsChangedOnMain,
      rowsChangedInPr,
    }),
  };
}

function summarize(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${lines.join('\n\n')}\n`);
}

function parseArgs(argv) {
  const opts = { all: false, pr: null, label: false, fromJson: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--label') opts.label = true;
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
      rowsChangedInPr: new Map(
        Object.entries(input.rowsChangedInPr ?? {}).map(([k, v]) => [k, new Set(v)])
      ),
    });
    const verdict = formatVerdict({
      pr: input.pr ?? 0,
      baseSha: input.baseSha ?? null,
      commitsBehind: input.commitsBehind ?? 0,
      movedFileCount: (input.movedFiles ?? []).length,
      result,
    });
    console.log(verdict);
    process.exit(result.stale ? 1 : 0);
  }

  const repo =
    process.env.GITHUB_REPOSITORY ||
    ghJson(['repo', 'view', '--json', 'nameWithOwner'], 'this repository\'s name').nameWithOwner;
  // TWO SOURCES OF TRUTH FOR MAIN'S TIP IS A MEASURED FAILURE, NOT A THEORY.
  // Every diff below is taken from local git, so reading the tip from the API
  // means comparing a local object database against a sha it may not contain.
  // A sweep run minutes after a fetch did exactly that: main had moved on the
  // API, all 35 PRs threw on `rev-list`, and the summary line still printed
  // `0 of 35 open PR(s) STALE`. Only the exit code told the truth. CI has the
  // same window between its checkout and an API read, and
  // `cancel-in-progress` does not close it. So the tip is the checkout's own
  // HEAD, which on `push: main` IS the commit that triggered the run.
  const mainTip = resolveMainTip(repo);

  if (opts.pr) {
    const pr = ghJson(['api', `repos/${repo}/pulls/${opts.pr}`], `PR #${opts.pr}`);
    let report;
    try {
      report = evaluatePr(repo, { number: pr.number, headRefOid: pr.head.sha }, mainTip, snapshots);
    } catch (err) {
      // Exit 2, NOT 1. Exit 1 is the STALE verdict, so crashing with it tells a
      // caller reading the exit code that the PR is stale -- a verdict this run
      // never reached. Unevaluated is its own outcome here exactly as it is in
      // the sweep.
      console.error(`check-base-freshness: PR #${opts.pr} could not be evaluated: ${err.message}`);
      process.exit(2);
    }
    console.log(formatVerdict(report));
    process.exit(report.result.stale ? 1 : 0);
  }

  if (!opts.all) {
    console.error('check-base-freshness: pass --pr <n>, --all, or --from-json <file>.');
    process.exit(2);
  }

  // NDJSON, one PR per line: `--jq` and `--slurp` are mutually exclusive in gh.
  // `base=main` IS LOAD-BEARING, not tidiness. A stacked PR's tested base is
  // its parent FEATURE BRANCH, and `git diff base..main` between two tips that
  // are not ancestors reverses the parent branch's own edits into the result --
  // so main appears to have touched files it never touched. Measured: 5 of 36
  // open PRs are stacked, and 4 of their base branches differ from main on a
  // snapshot; for #3405 the phantom "main moved" rows included
  // `apps/viewer/src/hooks/useBCF.ts` and `useIDS.ts`, which main never
  // touched -- the base branch added them. A PR stacked on that branch and
  // editing `useBCF.ts` would be labelled for a coupling that does not exist.
  const open = ghText([
    'api',
    '--paginate',
    `repos/${repo}/pulls?state=open&base=main&per_page=100`,
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
  const unevaluated = [];
  let displayFailures = 0;
  for (const pr of open) {
    let report;
    try {
      report = evaluatePr(repo, pr, mainTip, snapshots);
    } catch (err) {
      // UNEVALUATED IS NOT A VERDICT. It says nothing about this PR's base, so
      // it must not be labelled `base-stale` (that would blame the PR for the
      // sweep's own inability to look) and it must not be silently absent from
      // the count either -- a run where every PR threw once printed
      // `0 of 35 STALE`, which reads exactly like a clean sweep.
      console.error(`check-base-freshness: PR #${pr.number} could not be evaluated: ${err.message}`);
      unevaluated.push(pr.number);
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

  console.log(formatSweepSummary({ stale, open: open.length, unevaluated }));
  if (summaryLines.length > 0) summarize(summaryLines);

  // The sweep is a display, so a stale PR is not a failure of the sweep. Being
  // UNABLE to display is: a label that never landed is indistinguishable from a
  // clean PR to whoever reads the list before merging.
  process.exit(displayFailures > 0 ? 1 : 0);
}

if (isMainEntry(import.meta.url)) main();
