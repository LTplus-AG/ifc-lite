// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * "DID THIS REVIEW RECORD SEE THIS COMMIT?" -- asked only of fields that do not
 * move. Issues #3729 and #3730.
 *
 * Three predicates in this repository answered that question the same wrong
 * way: by comparing `commit_id` on `pulls/{n}/comments` to the PR head. THAT
 * FIELD IS RELOCATED ONTO A LATER HEAD. A row written against an older commit
 * reports a newer one, so the comparison returns `true` for a comment written
 * before the commit it names existed.
 *
 * MEASURED, NOT REASONED. `LTplus-AG/ifc-lite`, 2026-09-03, every open PR (36):
 * of 75 inline review comments, 14 were WRITTEN at their PR's head
 * (`original_commit_id === head`) and 36 more merely REPORT it. Counting
 * `commit_id === head` returns 50 where 14 qualify -- a 3.6x inflation of
 * "reviewed at head" on this repository's own traffic.
 *
 * THE FOUR FACTS THIS MODULE RESTS ON, EACH ONE OBSERVED:
 *
 *   1. ON A FORCE-PUSH, `commit_id` MOVES AND THE OTHER TWO DO NOT. PR #3719
 *      (merged), head `b7352e6d0` committed 2026-09-02T18:59:03Z:
 *
 *        endpoint              field                value       moved?
 *        pulls/3719/comments   commit_id            b7352e6d0   YES (= head)
 *        pulls/3719/comments   original_commit_id   fecc421e9   no
 *        pulls/3719/comments   created_at           17:30:48Z   no
 *        pulls/3719/reviews    commit_id            fecc421e9   no
 *
 *      That comment was written 88 minutes before the commit its `commit_id`
 *      names. The review EVENT for the same pass still names `fecc421e9`.
 *
 *   2. IT IS NOT A FORCE-PUSH HAZARD (louistrue, on #3729: "force-push is not
 *      the only trigger"), AND THE FIELD WAS WATCHED MOVING. PR #3610 carries
 *      three comments posted by `chatgpt-codex-connector[bot]` in ONE batch at
 *      2026-09-01T08:18:46Z, all with `original_commit_id` `260a6aeea`. Read
 *      twice on 2026-09-03, hours apart, while the PR took ordinary
 *      fast-forward pushes:
 *
 *        read      PR head      the three rows' `commit_id`
 *        first     411d93b40    260a6aeea, 260a6aeea, 411d93b40
 *        second    bf323cc71    260a6aeea, 260a6aeea, bf323cc71
 *
 *      The SAME row reported a different commit on the second read, and
 *      `original_commit_id` and `created_at` were byte-identical both times. So
 *      `commit_id` is a POINTER THAT TRACKS THE HEAD, not a record of what was
 *      reviewed -- and it moves on a subset of a batch, so nothing about a
 *      sibling row predicts it. This module therefore claims NO mechanism and
 *      needs none: both fields it reads are correct whether GitHub relocates a
 *      row or a bot re-posts one, because a re-posted row is a genuinely new
 *      row with its own `original_commit_id` and `created_at`.
 *
 *   3. `commit_id` DOES NOT EVEN RELOCATE TO THE *CURRENT* HEAD RELIABLY. On PR
 *      #3389 (head `9c79d14d1`) a comment with `original_commit_id`
 *      `3b176b9e1` reports `c85c0f499` -- an intermediate commit. So
 *      `commit_id !== head` is not a sound negative either, and the field is
 *      unusable for provenance in both directions, not merely optimistic.
 *
 *   4. THE CLOCK IS A ONE-WAY PROOF AND THE OTHER DIRECTION IS NOT
 *      HYPOTHETICAL. PR #3595's head was committed 14:48:28Z; two of its
 *      comments were created at 14:48:41Z and 14:48:51Z -- AFTER the head
 *      commit -- and were written against `68b13a657`, not the head. So
 *      "created before the head commit" proves a row did not see the head, and
 *      "created after" proves nothing at all.
 *
 * SO THE TWO USABLE FACTS, AND WHAT EACH CAN AND CANNOT ANSWER:
 *
 *   `original_commit_id === headSha`  is the ONLY positive evidence that an
 *   inline row was written against the head. It is frozen (fact 1). Nothing
 *   else on that endpoint can assert it: `commit_id` relocates, and a timestamp
 *   cannot say WHICH commit was read.
 *
 *   `created_at`/`submitted_at` < head commit time  is PROOF that a record did
 *   not see the head: it predates the commit. Independent of anchoring, and
 *   one-way only (fact 4). It corroborates the SHA rather than replacing it.
 *
 *   AND IT ASSUMES ONE THING, WHICH IS WORTH NAMING RATHER THAN CALLING IT
 *   "monotone": the two sides are not read from the same clock.
 *   `created_at`/`submitted_at` are GitHub's, and `commit.committer.date` is
 *   whatever clock made the commit -- a developer's laptop, unless GitHub made
 *   it itself (a squash, "Update branch", an applied suggestion). A committing
 *   machine running AHEAD by more than the review-to-push gap could therefore
 *   make a review that did see the tree look older than it. Every other skew
 *   direction only loses true positives. That asymmetry is a reason to keep the
 *   SHA carrying the finding and the clock corroborating it, which is what the
 *   callers do -- and at `staleReviewSeverity: warn` a skewed clock can only
 *   mis-word a sentence, never move an exit code.
 *
 * Review EVENTS (`pulls/{n}/reviews`) are a different surface with a different
 * answer: their `commit_id` is frozen (fact 1), so it IS usable, which is why
 * `staleReviews` in pr-review-signal.mjs reads that endpoint and this module
 * only lends it the clock.
 *
 * Pure: no I/O, no `gh`, no clock of its own. Every caller supplies the head
 * and the head's commit time.
 */

/** Thrown for every fail-closed condition; `reason` is the machine-readable tag. */
export class ReviewProvenanceError extends Error {
  /**
   * @param {string} reason - machine-readable tag.
   * @param {string} message - human-facing text, naming the remedy.
   */
  constructor(reason, message) {
    super(message);
    this.name = 'ReviewProvenanceError';
    this.reason = reason;
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Which commit an inline review comment was WRITTEN against, refused rather than
 * guessed.
 *
 * `commit_id` IS NOT RETURNED, deliberately. This module's header spends its
 * length proving that field is unusable for provenance in both directions, and
 * a return shape that still offers it leaves the bug one destructure away --
 * the same reasoning `check-review-posted.mjs` gives for dropping `commitId`
 * from its normalised row. It is read here for one purpose: to say, in the
 * refusal below, which row could not be read. An unreadable `commit_id` is
 * therefore NOT fatal on its own -- refusing a required gate over a field this
 * module then discards would be a failure the verdict does not depend on.
 *
 * `original_commit_id` IS required. Treating a missing one as "not at head"
 * would silently stop counting real findings; treating it as "at head" would
 * restore the bug. All 75 inline comments on this repository's open PRs carry
 * it, so an absent one means the payload shape changed.
 *
 * @param {unknown} row - one `pulls/{n}/comments` entry.
 * @returns {{ written: string, createdAt: string | null }}
 */
export function inlineCommentAnchors(row) {
  const rec = row && typeof row === 'object' ? /** @type {any} */ (row) : {};
  const claimed = rec.commit_id;
  const written = rec.original_commit_id;
  if (typeof written !== 'string' || !SHA_RE.test(written)) {
    const naming =
      typeof claimed === 'string' && SHA_RE.test(claimed)
        ? `reporting \`commit_id\` ${claimed.slice(0, 9)}`
        : `whose \`commit_id\` is also unreadable (${JSON.stringify(claimed)})`;
    throw new ReviewProvenanceError(
      'UNREADABLE_ANCHOR',
      `An inline review comment ${naming} has \`original_commit_id\` ` +
        `${JSON.stringify(written)}, which is not a commit SHA. That field is the only frozen ` +
        'provenance on this surface (#3729): `commit_id` relocates onto a later head, so without ' +
        '`original_commit_id` there is nothing left that says which commit was read. REMEDY: fix ' +
        'the reader; do NOT fall back to `commit_id`.',
    );
  }
  const createdAt = typeof rec.created_at === 'string' ? rec.created_at : null;
  return { written, createdAt };
}

/**
 * Was this inline comment WRITTEN against `headSha`?
 *
 * The positive test, and the only one there is. `original_commit_id` is frozen;
 * `commit_id` is not, in either direction (see facts 1 and 3).
 *
 * @param {unknown} row - one `pulls/{n}/comments` entry.
 * @param {string} headSha - the PR head, 40 hex.
 * @returns {boolean}
 */
export function wroteAtCommit(row, headSha) {
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) {
    throw new ReviewProvenanceError(
      'NO_HEAD_SHA',
      `\`headSha\` must be a 40-hex commit SHA; got ${JSON.stringify(headSha)}. Every row would ` +
        'compare unequal to an unreadable head, so this refuses rather than reporting every ' +
        'comment stale.',
    );
  }
  return inlineCommentAnchors(row).written === headSha;
}

/**
 * Is this a usable commit timestamp?
 *
 * `typeof === 'string'` IS LOAD-BEARING, not belt-and-braces. `Date.parse` is
 * called on `String(value)`, and `String(0)` is `"0"`, which V8 parses happily
 * as the year 2000 — so a numeric `0` reaching a clock comparison would not
 * refuse, it would silently place the head commit in 2000 and report every
 * review as "not older than the head". A validity check that accepts a wrong
 * answer is worse than none.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCommitTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Did `timestamp` happen strictly before `headCommittedAt`?
 *
 * `true` is a PROOF that whatever happened at `timestamp` cannot have seen the
 * head commit. `false` is NOT the converse and must never be read as one -- see
 * fact 4 in the header.
 *
 * `null` means the question could not be asked: an absent or unparseable
 * timestamp on either side. Never `false`, because a missing timestamp reported
 * as "not stale" is absence reading as success.
 *
 * Exported although `ageAgainstCommit` is its only caller in this tree: those
 * three answers are the module's contract, and the formatter collapses `false`
 * and `null` to the same `null`, so the distinction can only be asserted here.
 *
 * IT IS ALSO NOT THE ONLY ANSWER TO THIS QUESTION IN THE REPO, AND SAYING SO IS
 * THE POINT. `scripts/lib/coderabbit-review-state.mjs` reached the same
 * predicate independently (`reviewAt < commitAt`, null-means-cannot-answer),
 * and it and `scripts/lib/pr-green-sweep.mjs` define the head instant as
 * `pushedDate ?? committedDate` where this module's callers use
 * `commit.committer.date`. On a rebased head those differ. This module owns the
 * SHA question outright -- every caller goes through `wroteAtCommit` -- but it
 * does NOT yet own the clock question, and a reader should not infer from the
 * header that it does. Consolidating means touching an `@unwired-by-design`
 * gate, so it is deliberately left out of #3729/#3730.
 *
 * @param {string | null | undefined} timestamp
 * @param {string | null | undefined} headCommittedAt
 * @returns {boolean | null}
 */
export function predatesCommit(timestamp, headCommittedAt) {
  // BOTH SIDES THROUGH `isCommitTime`, not a bare `Date.parse`. This used to
  // parse `String(value)`, and `String(0)` is `"0"`, which V8 reads as the year
  // 2000 -- so a numeric timestamp would have compared as a real date and
  // manufactured a stale finding with a fabricated duration instead of
  // answering `null`.
  if (!isCommitTime(timestamp) || !isCommitTime(headCommittedAt)) return null;
  return Date.parse(timestamp) < Date.parse(headCommittedAt);
}

/**
 * How far before the head commit a record was written, as human text. Returns
 * `null` whenever `predatesCommit` did not answer `true`, so a caller cannot
 * print a duration over a comparison nobody made.
 *
 * @param {string | null | undefined} timestamp
 * @param {string | null | undefined} headCommittedAt
 * @returns {string | null}
 */
export function ageAgainstCommit(timestamp, headCommittedAt) {
  if (predatesCommit(timestamp, headCommittedAt) !== true) return null;
  const seconds = Math.round(
    (Date.parse(String(headCommittedAt)) - Date.parse(String(timestamp))) / 1000,
  );
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = seconds / 3600;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}
