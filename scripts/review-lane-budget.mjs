/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Claude lane may run for twenty minutes. The review-posted gate must wait
 * longer than that, and its job must leave enough time to print a verdict.
 *
 * These are the behaviour limits the two lanes promise one another, kept as
 * executable policy so the gate can DERIVE its `--timeout-seconds` from them.
 *
 * The two `timeout-minutes:` values are still copies, unavoidably: GitHub
 * evaluates them before any step runs, so no workflow can read this module for
 * them. `THE COPIES`, in scripts/check-review-posted.test.mjs, parses both out
 * of the YAML and fails when either drifts from the constant here. That test is
 * load-bearing -- deleting it silently reopens the 600s-vs-1200s race this
 * module exists to close.
 */
export const REVIEW_LANE_TIMEOUT_SECONDS = 20 * 60;
export const REVIEW_POSTED_POLL_SECONDS = 25 * 60;
export const REVIEW_POSTED_JOB_TIMEOUT_SECONDS = 30 * 60;
export const REVIEW_POSTED_MINIMUM_GRACE_SECONDS = 5 * 60;

export function assertReviewLaneBudget({
  laneTimeoutSeconds = REVIEW_LANE_TIMEOUT_SECONDS,
  pollSeconds = REVIEW_POSTED_POLL_SECONDS,
  gateJobTimeoutSeconds = REVIEW_POSTED_JOB_TIMEOUT_SECONDS,
  minimumGraceSeconds = REVIEW_POSTED_MINIMUM_GRACE_SECONDS,
} = {}) {
  if (pollSeconds <= laneTimeoutSeconds) {
    throw new Error(
      `Review-posted polls for ${pollSeconds}s, but the review lane may run for ${laneTimeoutSeconds}s, ` +
        'so the gate can give up while the reviewer is still working and report NOT_POSTED on a ' +
        `good PR. Remedy: raise the poll budget above ${laneTimeoutSeconds}s (REVIEW_POSTED_POLL_SECONDS), ` +
        'or lower claude-review.yml timeout-minutes and REVIEW_LANE_TIMEOUT_SECONDS together.',
    );
  }
  if (gateJobTimeoutSeconds - pollSeconds < minimumGraceSeconds) {
    throw new Error(
      `Review-posted job leaves ${gateJobTimeoutSeconds - pollSeconds}s after its ${pollSeconds}s poll; ` +
        `it needs at least ${minimumGraceSeconds}s to print a verdict, or it is killed mid-wait with ` +
        'no verdict at all. Remedy: raise review-posted.yml timeout-minutes and ' +
        'REVIEW_POSTED_JOB_TIMEOUT_SECONDS together, or lower the poll budget.',
    );
  }
}

export function pollSecondsArgument() {
  assertReviewLaneBudget();
  return String(REVIEW_POSTED_POLL_SECONDS);
}
