#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Reports open PRs whose `pull_request` CI never ran because the PR is
 * conflicted (issue #3443). See scripts/lib/dirty-pr-scan.mjs for the measured
 * evidence and the classification rule; this file is the I/O half.
 *
 * WHY THIS RUNS ON `schedule`/`workflow_dispatch` AND NOT `pull_request`: the
 * whole defect is that GitHub does not fire `pull_request` for a PR it cannot
 * compute a merge ref for. A job triggered BY `pull_request` -- including
 * `.github/workflows/pr-review-signal.yml`, built for the adjacent absence
 * defect in #3312 -- inherits exactly the blindness it would need to report on.
 * Only a job on an independent trigger, asking the API which open PRs are
 * conflicted, can see this. See .github/workflows/dirty-pr-scan.yml.
 *
 * WHAT IT REPORTS: the two causes of silent `pull_request` CI, separately,
 * because they take opposite remedies -- a base `test.yml` does not run on
 * (#3429's first case: retarget the PR; a merge cannot help) and an unresolved
 * merge conflict (#3443, #3429's second case: resolve it). See
 * `classifyPr` in scripts/lib/dirty-pr-scan.mjs.
 *
 * WHAT THIS CANNOT DETECT: a single-PR problem (this only runs against the
 * live list of open PRs, on a cron cadence, and has no way to answer "is PR #N
 * clean right now" between runs), a PR that has gone quietly stale (GitHub's
 * own `UNKNOWN` mergeable state is reported but not failed on, since it
 * self-resolves), and a lane ABSENT for a reason this gate cannot name -- a
 * real failure, a path filter, a lane still queued on an otherwise-clean PR --
 * which is deliberately out of scope, since naming a cause it has not
 * established is how a gate starts handing out remedies that do not work. It
 * also cannot detect conflicts closed and reopened between polls; the cron
 * interval IS the detection latency.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DirtyPrScanError,
  cadenceReport,
  pullRequestBaseBranches,
  report,
  scanPrs,
} from './lib/dirty-pr-scan.mjs';
import { expandJobNames, matrixSkipAliases } from './lib/pr-review-signal.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const DEFAULT_WORKFLOW = join(REPO_ROOT, '.github/workflows/test.yml');
// This scan's OWN workflow, for the cadence report (#3776).
const OWN_WORKFLOW_FILE = 'dirty-pr-scan.yml';
const OWN_WORKFLOW = join(REPO_ROOT, '.github/workflows', OWN_WORKFLOW_FILE);
const FALLBACK_CRON_MINUTES = 30;

/**
 * The declared cron interval, read from the workflow rather than pinned here:
 * a constant that drifts from the schedule reports a wrong staleness threshold,
 * and a wrong threshold is worse than a missing one. Falls back when the
 * schedule is not the simple every-N-minutes form this understands.
 *
 * @param {string} path
 */
function cronMinutesFrom(path) {
  try {
    const m = /^\s*-\s*cron:\s*['"]\*\/(\d+) \* \* \* \*['"]/m.exec(readFileSync(path, 'utf8'));
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_CRON_MINUTES;
  } catch {
    return FALLBACK_CRON_MINUTES;
  }
}

// Same exclusion as scripts/pr-review-signal.config.json's `excludeJobKeys`,
// and the same reason: the `test` aggregate `needs:` every other job and
// publishes no check run until all finish, so requiring it here would flag a
// PR that is merely mid-run as though it were conflicted-and-silent. This
// scan runs on a cron cadence rather than right after a push, so that race is
// narrower than #3312's, but it is not zero -- a PR can go dirty seconds after
// a push the cron catches mid-flight.
const EXCLUDE_JOB_KEYS = ['test'];

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = {
    workflow: DEFAULT_WORKFLOW,
    repo: process.env.GITHUB_REPOSITORY,
    limit: 100,
    stateFile: null,
    summaryFile: process.env.GITHUB_STEP_SUMMARY ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--workflow') args.workflow = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--state-file') args.stateFile = argv[++i];
    else if (a === '--summary-file') args.summaryFile = argv[++i];
    else {
      throw new DirtyPrScanError('BAD_ARGS', `Unrecognized argument \`${a}\`.`);
    }
  }
  return args;
}

/**
 * `gh` with fail-closed error handling, matching
 * scripts/check-pr-review-signal.mjs's `gh()`: anything other than a clean
 * exit and parseable JSON is a named error, never an empty result standing in
 * for "no open PRs".
 *
 * @param {string[]} args
 * @param {string} what
 */
function gh(args, what) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw new DirtyPrScanError(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to fetch ${what}: ${r.error.message}.`,
    );
  }
  if (r.status !== 0) {
    throw new DirtyPrScanError(
      'GH_ERROR',
      `\`gh ${args.join(' ')}\` exited ${r.status} while fetching ${what}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}`,
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new DirtyPrScanError(
      'GH_BAD_JSON',
      `\`gh ${args.join(' ')}\` returned unparseable output while fetching ${what}: ${err.message}`,
    );
  }
}

function fetchOpenPrs({ repo, limit }) {
  return gh(
    [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      // `baseRefName` is load-bearing, not decoration: without it `classifyPr`
      // cannot tell a stacked PR from a conflicted one and fails closed.
      'number,title,url,baseRefName,mergeable,mergeStateStatus,isDraft,statusCheckRollup',
      '--limit',
      String(limit),
      '--repo',
      repo,
    ],
    'the open PR list',
  );
}

/**
 * The cadence half (#3776): when did this workflow last run, and was the gap
 * long enough that `main` was carrying a stale verdict?
 *
 * IT NEVER FAILS THE SCAN. `gh()` is fail-closed by design -- the lane verdict
 * must not rest on a half-read API -- but a cadence line is commentary about
 * the scan rather than part of it, so a `gh` failure is caught here and handed
 * to `cadenceReport` as an explicit UNKNOWN. Letting it throw would replace the
 * PR findings with an error about the reporting of them.
 *
 * ONLY `success`/`failure` RUNS COUNT. This workflow now has a `concurrency`
 * block, so a cron tick landing next to a push leaves CANCELLED runs behind; a
 * cancelled run never scanned anything, and counting one as "the last run"
 * would report a healthy cadence over a window where nothing was checked.
 * `--status completed` does NOT exclude them -- cancelled IS completed -- so
 * the filter is on `conclusion`.
 *
 * @param {{ repo: string, workflowFile: string, runId: string | undefined, cronMinutes: number }} o
 */
function cadence({ repo, workflowFile, runId, cronMinutes }) {
  let previousCreatedAt = null;
  let ghError = null;
  try {
    const runs = gh(
      [
        'run',
        'list',
        '--workflow',
        workflowFile,
        '--repo',
        repo,
        // Well above the number of runs a single cron window can produce, so a
        // burst of cancelled or in-progress runs cannot push the last real one
        // off the end of the page and fake a first-run report.
        '--limit',
        '60',
        '--json',
        'databaseId,createdAt,conclusion',
      ],
      "this workflow's own run history",
    );
    const previous = (Array.isArray(runs) ? runs : [])
      .filter((r) => String(r?.databaseId) !== String(runId))
      .filter((r) => r?.conclusion === 'success' || r?.conclusion === 'failure')
      .map((r) => r?.createdAt)
      .filter((t) => typeof t === 'string' && t !== '')
      .sort()
      .pop();
    previousCreatedAt = previous ?? null;
  } catch (err) {
    ghError = err instanceof DirtyPrScanError ? `${err.reason}: ${err.message}` : String(err);
  }
  return cadenceReport({ previousCreatedAt, now: new Date(), cronMinutes, ghError });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.workflow)) {
    throw new DirtyPrScanError(
      'NO_WORKFLOW_TEXT',
      `Workflow \`${args.workflow}\` does not exist, so the required lane set cannot be derived.`,
    );
  }
  const workflowText = readFileSync(args.workflow, 'utf8');
  const required = expandJobNames(workflowText, { exclude: EXCLUDE_JOB_KEYS });
  const baseBranches = pullRequestBaseBranches(workflowText);
  // Same exclude list as `expandJobNames` above -- passing it to only one of
  // the two derivations is a silent, asymmetric failure: the lane would stay
  // required while its wholesale-skip alias disappears.
  const aliases = matrixSkipAliases(workflowText, { exclude: EXCLUDE_JOB_KEYS });

  let prs;
  if (args.stateFile) {
    // Offline mode for the regression harness: a JSON array standing in for
    // `gh pr list`'s output, driving the identical `scanPrs`/`report`.
    prs = JSON.parse(readFileSync(args.stateFile, 'utf8'));
  } else {
    if (!args.repo) {
      throw new DirtyPrScanError(
        'NO_REPO',
        'Pass `--repo owner/name` or set GITHUB_REPOSITORY (or use `--state-file` for tests).',
      );
    }
    prs = fetchOpenPrs({ repo: args.repo, limit: args.limit });
  }

  const results = scanPrs(prs, required, baseBranches, aliases);
  const { ok, lines } = report(results, required, baseBranches);
  // The SAME set the report calls silent -- deliberately not `unknownAdvisory`,
  // which the scanner keeps out of `silent` because those PRs re-check
  // themselves.
  const silentNumbers = results.filter((r) => r.silent).map((r) => r.number);

  // Live mode only: offline `--state-file` runs are the regression harness,
  // which has no run history to ask about and must not shell out to `gh`.
  const cadenceLines = [];
  if (!args.stateFile && args.repo) {
    const c = cadence({
      repo: args.repo,
      workflowFile: OWN_WORKFLOW_FILE,
      runId: process.env.GITHUB_RUN_ID,
      cronMinutes: cronMinutesFrom(OWN_WORKFLOW),
    });
    cadenceLines.push('', ...c.lines);
    // The annotation goes to STDOUT and only there. Written into the summary
    // file instead it would be a staleness report that is itself invisible.
    if (c.warning) console.log(`::warning::${c.warning}`);
  }

  const out = [...lines, ...cadenceLines];
  for (const l of out) console.log(l);

  if (args.summaryFile) {
    try {
      appendFileSync(args.summaryFile, `\n${out.join('\n')}\n`);
    } catch {
      // A summary write failing is not itself a reason to fail the scan.
    }
  }

  // THE SILENT SET, FOR MACHINES. Screen-scraping the human lines picked up
  // the `unknownAdvisory` block too -- PRs the scanner deliberately keeps OUT
  // of `silent` because they re-check themselves -- so a freshly opened PR got
  // labelled and unlabelled every 30 minutes. Emitting the set the scanner
  // actually computed removes the second, divergent derivation.
  console.log(`silent-prs=${silentNumbers.join(',')}`);

  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('scan-dirty-prs.mjs')) {
  try {
    await main();
  } catch (err) {
    if (err instanceof DirtyPrScanError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      // EXIT 2, NOT 1. `1` means "the scan looked and found silent PRs"; this
      // means "the scan could not look". A caller that acts on the finding --
      // labelling the PRs it named, clearing the label from the rest -- must
      // be able to tell those apart, or a transient HTTP 502 reads as "no PR
      // is silent any more" and clears correct state.
      process.exit(2);
    }
    throw err;
  }
}
