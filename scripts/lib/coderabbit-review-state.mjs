// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Classify what a CodeRabbit check actually means on a pull request.
 *
 * A green `CodeRabbit: pass` does NOT mean the diff was reviewed. Three states
 * render as the same tick:
 *
 *   1. reviewed the full diff, found nothing        -> a real pass
 *   2. reviewed only the newest commit              -> partial
 *   3. never ran at all (rate limited, or errored)  -> no review happened
 *
 * Under Fair Usage rate limiting, state 3 is green on every open PR at once, so
 * "all our PRs show CodeRabbit passing" is a symptom rather than reassurance.
 *
 * TWO SIGNALS ARE NEEDED, AND NEITHER WORKS ALONE.
 *
 * The rate-limit HTML sentinel alone gives FALSE POSITIVES. A PR can carry the
 * sentinel verbatim -- "Review limit reached", "Next review available in N
 * minutes" -- and still have genuine inline findings posted minutes later,
 * because the summary comment is not rewritten when a later pass succeeds.
 * Observed on a PR whose sentinel claimed a 51-minute wait while two inline
 * findings landed four minutes after it.
 *
 * So the sentinel is only conclusive when the inline thread count is also zero.
 *
 * This module is the pure classifier and takes no I/O, so it can be tested
 * against synthetic inputs. `scripts/check-coderabbit-review.mjs` supplies the
 * GitHub calls.
 */

/** The marker CodeRabbit embeds in a rate-limited summary comment. */
export const RATE_LIMIT_SENTINEL =
  'auto-generated comment: rate limited by coderabbit.ai';

/**
 * @param {{ bodies: string[], inlineThreadCount: number }} input
 *   `bodies` are the comment bodies authored by CodeRabbit (issue comments).
 *   `inlineThreadCount` is the number of review threads whose first comment is
 *   authored by CodeRabbit.
 *
 *   NOTE for the caller: `gh pr view --json comments` does NOT return inline
 *   review threads. The count has to come from `reviewThreads` via GraphQL, or
 *   it is always zero and every PR looks unreviewed.
 *
 * @returns {{ state: string, reviewed: boolean, why: string }}
 *   state is one of NO-REVIEW | UNREVIEWED | STALE-SUMMARY | REVIEWED | INCONCLUSIVE.
 *   `reviewed` is false only when we can show no review ran.
 */
export function classifyReviewState({ bodies, inlineThreadCount }) {
  const threads = inlineThreadCount ?? 0;
  const joined = bodies.join('\n');
  const sentinel = bodies.some((b) => b.includes(RATE_LIMIT_SENTINEL));

  // A real review names the run it came from and the files it read.
  const runId = joined.match(/Run ID:?\s*([0-9a-f-]{8,})/i)?.[1] ?? null;
  const namesFiles = joined.includes('Files selected for processing');

  if (bodies.length === 0) {
    return {
      state: 'NO-REVIEW',
      reviewed: false,
      why: 'CodeRabbit posted no comment at all',
    };
  }
  if (sentinel && threads === 0) {
    return {
      state: 'UNREVIEWED',
      reviewed: false,
      why: 'rate-limit sentinel present AND zero inline threads',
    };
  }
  if (sentinel && threads > 0) {
    // The sentinel is stale: findings exist, so a pass did run afterwards.
    return {
      state: 'STALE-SUMMARY',
      reviewed: true,
      why: `sentinel present but ${threads} inline thread(s) exist - a review did run`,
    };
  }
  if (runId || namesFiles || threads > 0) {
    return {
      state: 'REVIEWED',
      reviewed: true,
      why: `runId=${runId ?? 'n/a'} namesFiles=${namesFiles} threads=${threads}`,
    };
  }
  // A comment with none of the three markers tells us nothing either way.
  return {
    state: 'INCONCLUSIVE',
    reviewed: true,
    why: 'no sentinel, no Run ID, no file list, no inline threads',
  };
}
