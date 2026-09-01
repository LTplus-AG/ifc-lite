/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Claude lane may run for twenty minutes. The review-posted gate must wait
 * longer than that, and its job must leave enough time to print a verdict.
 *
 * Keep this as executable policy rather than a test that inspects workflow
 * text: workflow layout is an implementation detail, while these are the
 * behaviour limits the two lanes promise one another.
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
      `Review-posted polls for ${pollSeconds}s, but the review lane may run for ${laneTimeoutSeconds}s.`,
    );
  }
  if (gateJobTimeoutSeconds - pollSeconds < minimumGraceSeconds) {
    throw new Error(
      `Review-posted job leaves ${gateJobTimeoutSeconds - pollSeconds}s after its ${pollSeconds}s poll; ` +
        `it needs at least ${minimumGraceSeconds}s to print a verdict.`,
    );
  }
}

export function pollSecondsArgument() {
  assertReviewLaneBudget();
  return String(REVIEW_POSTED_POLL_SECONDS);
}
