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
 * THREE SIGNALS ARE NEEDED, AND NONE OF THEM WORKS ALONE.
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
 * The comment bodies alone give FALSE NEGATIVES. CodeRabbit leaves inline
 * findings while its summary comment is absent, deleted, or rewritten in place.
 * Inline threads are the evidence that survives all three, so an empty body
 * list is not absence of review -- it is absence of review only when the inline
 * thread count is zero as well.
 *
 * And neither signal carries TIME, so on their own both certify the wrong
 * commit. A review posted before the latest push is evidence about a diff that
 * no longer exists, while the tick stays green and the bot never saw the new
 * commits. The caller therefore also supplies when the newest review evidence
 * landed and when the head commit arrived, and evidence older than its head
 * commit is reported as not covering it.
 *
 * WHICH WAY TO FAIL WHEN THE EVIDENCE RUNS OUT.
 *
 * The two mistakes are not symmetric. A false "not reviewed" is loud and
 * self-correcting: someone opens the PR, sees the review, and moves on. A false
 * "reviewed" is silent and terminal: nobody looks again, and this tool has
 * certified the exact thing it exists to catch. So every ambiguous case here
 * resolves to `reviewed: false` -- an unmarked comment, a missing timestamp, an
 * unparseable one. Absence of evidence is never reported as evidence of review.
 *
 * This module is the pure classifier and takes no I/O, so it can be tested
 * against synthetic inputs. `scripts/check-coderabbit-review.mjs` supplies the
 * GitHub calls.
 */

/** The marker CodeRabbit embeds in a rate-limited summary comment. */
export const RATE_LIMIT_SENTINEL =
  'auto-generated comment: rate limited by coderabbit.ai';

/**
 * Parse an ISO-8601 instant into epoch millis, or null when it is absent or
 * unparseable.
 *
 * Returning null rather than NaN is the point. Every `<` and `>` against NaN is
 * false in BOTH directions, so an unparseable timestamp compared directly would
 * fall through to the "new enough" branch -- the reassuring answer, reached by
 * accident, on no evidence at all. Callers must branch on null explicitly.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * What the comment bodies and inline threads show, ignoring time.
 *
 * @param {string[]} bodies
 * @param {number} threads
 * @returns {{ state: string, reviewed: boolean, why: string }}
 */
function classifyEvidence(bodies, threads) {
  const joined = bodies.join('\n');
  const sentinel = bodies.some((b) => b.includes(RATE_LIMIT_SENTINEL));

  // A real review names the run it came from and the files it read.
  const runId = joined.match(/Run ID:?\s*([0-9a-f-]{8,})/i)?.[1] ?? null;
  const namesFiles = joined.includes('Files selected for processing');

  // Only the absence of BOTH signals is absence of review. An empty body list
  // with live inline threads is a review whose summary was never posted or was
  // deleted -- not a review that never ran.
  if (bodies.length === 0 && threads === 0) {
    return {
      state: 'NO-REVIEW',
      reviewed: false,
      why: 'CodeRabbit posted no comment and left no inline thread',
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
  // A comment carrying none of the markers shows nothing either way, and
  // "nothing either way" is not a review. Calling it reviewed is the silent,
  // terminal mistake; calling it unreviewed costs one glance at the PR.
  return {
    state: 'INCONCLUSIVE',
    reviewed: false,
    why: 'a CodeRabbit comment exists but carries no sentinel, no Run ID, no file list, and no inline threads',
  };
}

/**
 * @param {{
 *   bodies: string[],
 *   inlineThreadCount: number,
 *   latestReviewAt?: string | null,
 *   headCommitAt?: string | null,
 * }} input
 *   `bodies` are the comment bodies authored by CodeRabbit (issue comments).
 *   `inlineThreadCount` is the number of review threads whose first comment is
 *   authored by CodeRabbit.
 *   `latestReviewAt` is the ISO-8601 instant of the NEWEST piece of CodeRabbit
 *   review evidence: the latest of any inline thread's first-comment
 *   `createdAt`, any CodeRabbit review's `submittedAt`, and any CodeRabbit
 *   issue comment's `created_at`.
 *   `headCommitAt` is the ISO-8601 instant the head commit reached the PR --
 *   `pushedDate`, falling back to `committedDate` where GitHub returns none.
 *
 *   NOTE for the caller: `gh pr view --json comments` does NOT return inline
 *   review threads. The count has to come from `reviewThreads` via GraphQL, or
 *   it is always zero and every PR looks unreviewed. The same query is where
 *   both timestamps come from; the REST comment list carries neither.
 *
 * @returns {{ state: string, reviewed: boolean, why: string }}
 *   state is one of NO-REVIEW | UNREVIEWED | INCONCLUSIVE | PRE-PUSH-REVIEW |
 *   UNDATED | STALE-SUMMARY | REVIEWED. `reviewed` is true only for the last
 *   two, and only once the evidence is shown to be no older than the head
 *   commit.
 */
export function classifyReviewState({
  bodies,
  inlineThreadCount,
  latestReviewAt,
  headCommitAt,
}) {
  const threads = inlineThreadCount ?? 0;
  const evidence = classifyEvidence(bodies ?? [], threads);

  // Nothing to date: no review was shown in the first place.
  if (!evidence.reviewed) return evidence;

  const reviewAt = parseInstant(latestReviewAt);
  const commitAt = parseInstant(headCommitAt);

  if (reviewAt === null || commitAt === null) {
    return {
      state: 'UNDATED',
      reviewed: false,
      why:
        `${evidence.why}; but that evidence cannot be dated against the head commit ` +
        `(latestReviewAt=${latestReviewAt ?? 'missing'}, headCommitAt=${headCommitAt ?? 'missing'}) ` +
        '- an undated review is reported as not covering the head commit',
    };
  }
  if (reviewAt < commitAt) {
    return {
      state: 'PRE-PUSH-REVIEW',
      reviewed: false,
      why:
        `${evidence.why}; but the newest evidence (${new Date(reviewAt).toISOString()}) ` +
        `predates the head commit (${new Date(commitAt).toISOString()}) ` +
        '- it is about a diff that has since been replaced',
    };
  }
  return {
    ...evidence,
    why:
      `${evidence.why}; newest evidence (${new Date(reviewAt).toISOString()}) ` +
      `is not older than the head commit (${new Date(commitAt).toISOString()})`,
  };
}
