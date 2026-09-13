/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isMainEntry } from './lib/is-main-entry.mjs';

/**
 * The Claude lane may run for twenty minutes. The review-posted gate runs AFTER
 * it (`needs: review` in claude-review.yml), reads once with a short
 * propagation budget, and its job must leave enough time to print a verdict.
 *
 * These are the behaviour limits the two jobs promise one another, kept as
 * executable policy so the gate can DERIVE its `--timeout-seconds` from them.
 *
 * WHAT CHANGED, AND WHY THE FIRST RULE WENT AWAY (CI redesign, step 3). The
 * gate used to be its own workflow, started with the push and polled for the
 * marker in parallel with the lane; the race that produced (#3593: gate gave
 * up at 600 s, marker landed 29 s later) was closed by a RULE here, `poll >
 * lane timeout`, which meant a 25-minute poll holding a runner slot on every
 * PR. The race is now closed by ORDERING: the gate cannot start until the
 * lane has stopped, so no poll budget can expire while the reviewer is still
 * working, and the budget only has to cover API propagation of a comment
 * that was posted before the lane's job ended. The ordering is a YAML fact
 * this module cannot read; `THE COPIES` in scripts/check-review-posted.test.mjs
 * asserts `needs: review` on the gate job, and that assertion is what stands
 * where the rule used to.
 *
 * The two `timeout-minutes:` values are still copies, unavoidably: GitHub
 * evaluates them before any step runs, so no workflow can read this module for
 * them. `THE COPIES` parses both out of the YAML and fails when either drifts
 * from the constant here. That test is load-bearing -- deleting it silently
 * reopens the killed-mid-wait shape this module exists to close.
 *
 * The sibling `pr-review-signal` lane is deliberately NOT covered by
 * `assertReviewLaneBudget`: it reads a verdict rather than waiting on one, so
 * it has no poll budget to reconcile here.
 */
export const REVIEW_LANE_TIMEOUT_SECONDS = 20 * 60;
export const REVIEW_POSTED_POLL_SECONDS = 60;
export const REVIEW_POSTED_JOB_TIMEOUT_SECONDS = 10 * 60;
export const REVIEW_POSTED_MINIMUM_GRACE_SECONDS = 5 * 60;

export function assertReviewLaneBudget({
  pollSeconds = REVIEW_POSTED_POLL_SECONDS,
  gateJobTimeoutSeconds = REVIEW_POSTED_JOB_TIMEOUT_SECONDS,
  minimumGraceSeconds = REVIEW_POSTED_MINIMUM_GRACE_SECONDS,
} = {}) {
  if (!(pollSeconds > 0)) {
    throw new Error(
      `Review-posted poll budget must be a positive number of seconds; got ${pollSeconds}. A zero ` +
        'budget is a gate that reads once before the comment API has caught up with the post.',
    );
  }
  if (gateJobTimeoutSeconds - pollSeconds < minimumGraceSeconds) {
    throw new Error(
      `Review-posted job leaves ${gateJobTimeoutSeconds - pollSeconds}s after its ${pollSeconds}s poll; ` +
        `it needs at least ${minimumGraceSeconds}s to print a verdict, or it is killed mid-wait with ` +
        'no verdict at all. Remedy: raise the review-posted job\'s timeout-minutes in claude-review.yml ' +
        'and REVIEW_POSTED_JOB_TIMEOUT_SECONDS together, or lower the poll budget.',
    );
  }
}

export function pollSecondsArgument() {
  assertReviewLaneBudget();
  return String(REVIEW_POSTED_POLL_SECONDS);
}

const USAGE = 'usage: node scripts/review-lane-budget.mjs --poll-seconds';

/**
 * THE CLI IS THE WORKFLOW'S ONLY DOOR IN, so it must never exit 0 saying
 * nothing. `poll_seconds="$(node scripts/review-lane-budget.mjs ...)"` captures
 * stdout; an unrecognised flag that fell through silently would set an EMPTY
 * variable, and the gate would then be handed `--timeout-seconds ""` and exit
 * BAD_ARGS on every PR -- while every test here stayed green, because they all
 * call the module's functions rather than the command line CI actually runs.
 * That is exactly the shape this module was written to prevent, so: print, or
 * fail loudly.
 */
function runCli(argv) {
  if (argv.length !== 1 || argv[0] !== '--poll-seconds') {
    console.error(`${USAGE} (got: ${argv.join(' ') || 'no arguments'})`);
    return 2;
  }
  console.log(pollSecondsArgument());
  return 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    // A budget violation must reach the operator as text, not as a stack trace
    // swallowed by command substitution.
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
}
