/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A green reverted run supports a negative finding only when execution was
 * complete. Positive witnesses are decided before this function, so an
 * all-skipped sibling cannot erase a real assertion failure (#4109).
 */
export function passVerdict(baseline, reverted) {
  const allSkippedRuns = (baseline.allSkippedRuns ?? 0) + (reverted.allSkippedRuns ?? 0);
  if (allSkippedRuns > 0) {
    return {
      verdict: 'INCONCLUSIVE',
      exitCode: 3,
      reason:
        `the oracle saw ${allSkippedRuns} all-skipped package run(s). The executed tests stayed green, ` +
        'but incomplete execution cannot support an UNOBSERVED finding.',
      advice: 'Provision the skipped test prerequisites, or narrow --test to a fully executable witness.',
    };
  }
  return {
    verdict: 'UNOBSERVED',
    exitCode: 1,
    reason:
      `FINDING: with the production change fully reverted, all ${reverted.total} test(s) still PASS. ` +
      'The branch\'s tests do not observe the branch\'s change.',
    advice:
      'Either the test asserts something the change does not affect, or it stubs the very module ' +
      'the change lives in. Write a test that fails on this revert before shipping.',
  };
}
