#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sweep every open pull request and report which ones are ACTUALLY green.
 *
 *   node scripts/check-pr-green.mjs                # --author @me
 *   node scripts/check-pr-green.mjs --author BIMvoice
 *   node scripts/check-pr-green.mjs --json
 *
 * The sibling entry point, `check-coderabbit-review.mjs`, answers one question
 * per PR: did CodeRabbit read the diff at the head commit. This one answers the
 * whole readiness question across all of them at once, because a sweep of 36
 * open PRs turned up four more shapes that read as green in any report that
 * only counts failing and pending checks:
 *
 *   - `headRepositoryOwner.login` is not ours: somebody else's fork, and every
 *     other column is then a report about a branch we cannot push to.
 *   - `mergeStateStatus == DIRTY` with runs present: green checks over a base
 *     that no longer merges. Two PRs were in that state during the sweep.
 *   - zero workflow runs at the head commit: a PR that was DIRTY when the
 *     commit was pushed never gets a run, and the EMPTY rollup that leaves
 *     behind counts up as `fail=0, pending=0` -- the vacuous pass.
 *   - the newest run on the branch is against a superseded commit.
 *
 * It exists as a script rather than a habit because the sweep it replaces was
 * a throwaway someone had to remember to write again.
 *
 * @unwired-by-design every verdict here depends on transient GitHub state --
 * queued runs, review latency, a base that is DIRTY only until the next
 * rebase, and API rate limiting -- so a required check built on it would fail
 * for reasons that have nothing to do with the diff under test. The
 * classification it rests on IS wired: `scripts/lib/pr-green-sweep.test.mjs`
 * and `scripts/lib/coderabbit-review-state.test.mjs` both run in CI.
 *
 * Exits non-zero when any PR of ours is disqualified, so it can gate a "these
 * are all ready" claim -- and also when the sweep could not be completed, so a
 * broken sweep never renders as a clean one.
 */
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_REPO,
  SweepError,
  actionable,
  disqualify,
  formatSweep,
  sweepPullRequests,
} from './lib/pr-green-sweep.mjs';

const repo = process.env.CODERABBIT_CHECK_REPO ?? DEFAULT_REPO;

const args = process.argv.slice(2);
const authorFlag = args.indexOf('--author');
const author = authorFlag >= 0 ? args[authorFlag + 1] : '@me';
const asJson = args.includes('--json');

if (authorFlag >= 0 && !author) {
  console.error('check-pr-green: --author needs a value.');
  process.exit(2);
}

const gh = (argv) =>
  execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

let rows;
try {
  rows = sweepPullRequests({
    gh,
    repo,
    author,
    onProgress: () => process.stderr.write('.'),
  });
  process.stderr.write('\n');
} catch (err) {
  process.stderr.write('\n');
  if (err instanceof SweepError) {
    // Each kind gets its own message: the failures differ, and a single
    // "sweep failed" would hide which one happened -- including the empty
    // list, which is the one that most looks like success.
    const advice = {
      empty: 'Check --author and CODERABBIT_CHECK_REPO before assuming there is nothing to do.',
      unreachable: 'Re-run once `gh auth status` is healthy; do not read this as all-clear.',
      malformed: 'The sweep is incomplete, so no row in it can be trusted.',
    }[err.kind] ?? 'The sweep did not complete.';
    console.error(`check-pr-green: ${err.kind.toUpperCase()} - ${err.message}\n  ${advice}`);
    process.exit(1);
  }
  throw err;
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(formatSweep(rows, repo));
}

const blocked = actionable(rows, repo);
const notOurs = rows.filter((row) => row.headRepo !== repo).length;
console.log(
  `\n${rows.length} open PR(s) swept, ${notOurs} not ours, ` +
    `${blocked.length} of ours disqualified.`,
);
for (const row of blocked) console.log(`  #${row.number}  ${disqualify(row, repo)?.reason}`);
process.exit(blocked.length > 0 ? 1 : 0);
