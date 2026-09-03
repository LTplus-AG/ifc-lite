/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE ONE VERDICT THAT IS NOT `ok`, AND THE POLL RULE IT NEEDS (#3775).
 *
 * Split out of check-review-posted.mjs because that file is allowlisted at 859
 * lines and the house rule is SHRINK OR SPLIT, never raise the budget. These two
 * functions are one idea -- what `verdict=dropped` means and what the poll should
 * do about it -- so they leave together rather than being sliced by line count.
 *
 * WHY `dropped` IS NOT `ok`. Every other marker means the lane reached a
 * conclusion about the head, so `covered` (which `main()` writes as `ok`) is true
 * and claude-review.yml skips it. This one means the opposite: the reviewer ran,
 * was retried once, and NONE of its findings survived validation, so nothing was
 * posted and nothing vouches for the diff. Marking it covered would SEAL the
 * head -- the first all-dropped run would be the last, and a harness regression
 * dropping every finding on every PR would go quiet instead of red.
 *
 * The failure is CLEARABLE, which is the difference from an unclearable red: the
 * marker records what happened for a reader, the head stays uncovered, and the
 * next run reviews it again for real.
 */

/**
 * The gate result for a head carrying a `dropped` marker.
 *
 * @param {string} headSha
 * @returns {{ok: false, full: false, terminal: true, verdict: string, escapeHatch: null, lines: string[]}}
 */
export function droppedVerdict(headSha) {
  return {
    ok: false,
    full: false,
    // TERMINAL. Not `ok`, and yet there is nothing to wait for: the lane job that
    // wrote this marker has EXITED, so no later read of this head can find
    // anything else. Without the flag the poll waits on `!ok` alone and sits out
    // its whole budget -- ~25 minutes and ~200 API calls against a 1,000/hour
    // token shared with three other jobs -- to print a verdict the first read had.
    terminal: true,
    verdict: 'FINDINGS_ALL_DROPPED',
    escapeHatch: null,
    lines: [
      `❌ FINDINGS_ALL_DROPPED: the reviewer reached ${headSha.slice(0, 9)} and every finding it ` +
        'produced was refused by validation, so nothing was posted.',
      '   The marker records that outcome so the run is not invisible; it is NOT a verdict on the',
      '   diff. Nothing here was reviewed to a posted conclusion, so `full` and `covered` are both',
      '   false: CodeRabbit must not stand down, and the lane is free to review this head again.',
      '   The marker comment names which findings were dropped and why.',
      '   REMEDY: re-run the review job. The lane already retries this once on its own, so a',
      '   marker you can see means the retry was refused too -- if it recurs on the same head,',
      '   read the named reasons rather than re-running indefinitely.',
    ],
  };
}

/**
 * Is another read of this head worth making?
 *
 * NOT simply `!ok`. Most failing verdicts describe an ABSENCE -- no marker yet,
 * findings not visible yet -- and the whole reason the poll exists is that the
 * reviewer takes minutes and no event re-fires the gate when its comment lands.
 * `FINDINGS_ALL_DROPPED` is the opposite shape: the lane reached a conclusion,
 * wrote it, and exited. Waiting on it spends the entire budget to reprint a
 * verdict the first read already had.
 *
 * A separate predicate rather than a longer `while`, because the loop cannot be
 * driven from a test without a network and this decision can.
 *
 * @param {{ok: boolean, terminal?: boolean}} result
 */
export function shouldKeepPolling(result) {
  return !result.ok && result.terminal !== true;
}
