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
 * WHAT THIS CANNOT DETECT: a single-PR problem (this only runs against the
 * live list of open PRs, on a cron cadence -- it has no way to answer "is PR
 * #N clean right now" between runs; use `--pr` for that), a PR that has gone
 * quietly stale (GitHub's own `UNKNOWN` mergeable state is reported but not
 * failed on, since it self-resolves), and a PR whose lanes are ABSENT for a
 * DIFFERENT reason (a real failure, a path filter, #3429's base-branch filter
 * on a stacked PR) -- those aren't paired with `mergeable: CONFLICTING` and so
 * are out of scope for this specific gate on purpose. It also cannot detect
 * conflicts closed and reopened between polls; the cron interval IS the
 * detection latency.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DirtyPrScanError, scanPrs, report } from './lib/dirty-pr-scan.mjs';
import { expandJobNames } from './lib/pr-review-signal.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const DEFAULT_WORKFLOW = join(REPO_ROOT, '.github/workflows/test.yml');

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
      'number,title,url,mergeable,mergeStateStatus,isDraft,statusCheckRollup',
      '--limit',
      String(limit),
      '--repo',
      repo,
    ],
    'the open PR list',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.workflow)) {
    throw new DirtyPrScanError(
      'NO_WORKFLOW_TEXT',
      `Workflow \`${args.workflow}\` does not exist, so the required lane set cannot be derived.`,
    );
  }
  const required = expandJobNames(readFileSync(args.workflow, 'utf8'), { exclude: EXCLUDE_JOB_KEYS });

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

  const results = scanPrs(prs, required);
  const { ok, lines } = report(results, required);
  for (const l of lines) console.log(l);

  if (args.summaryFile) {
    try {
      appendFileSync(args.summaryFile, `\n${lines.join('\n')}\n`);
    } catch {
      // A summary write failing is not itself a reason to fail the scan.
    }
  }

  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('scan-dirty-prs.mjs')) {
  try {
    await main();
  } catch (err) {
    if (err instanceof DirtyPrScanError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
