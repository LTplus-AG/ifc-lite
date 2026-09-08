/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for scripts/lib/review-provenance.mjs (#3729, #3730).
 *
 * EVERY FIXTURE HERE IS A REAL ROW, copied from `LTplus-AG/ifc-lite` on
 * 2026-09-02/03 and named with the PR it came from. That is not decoration: the
 * module's whole claim is about which GitHub fields move and which do not, and
 * a fixture invented to match the implementation would prove only that the
 * implementation matches itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ReviewProvenanceError,
  ageAgainstCommit,
  inlineCommentAnchors,
  isCommitTime,
  predatesCommit,
  wroteAtCommit,
} from './review-provenance.mjs';

// ------------------------------------------------------------ real fixtures

/**
 * PR #3719, verbatim. Force-pushed: head `b7352e6d0` was committed
 * 2026-09-02T18:59:03Z, and this comment was created 88 minutes EARLIER against
 * `fecc421e9`. `commit_id` moved onto the new head; `original_commit_id` and
 * `created_at` did not. This single row is the whole issue.
 */
const PR3719_RELOCATED = {
  user: { login: 'coderabbitai[bot]' },
  commit_id: 'b7352e6d02ec7248c21a69ea68d845756249dfa3',
  original_commit_id: 'fecc421e93442e8364439ccf3d2826a9445f0819',
  created_at: '2026-09-02T17:30:48Z',
};
const PR3719_HEAD = 'b7352e6d02ec7248c21a69ea68d845756249dfa3';
const PR3719_HEAD_COMMITTED_AT = '2026-09-02T18:59:03Z';

/**
 * PR #3610 as read on 2026-09-03, and the reason this module names no mechanism.
 *
 * louistrue's correction on #3729: "force-push is not the only trigger". These
 * two rows were posted by ONE author in ONE batch at 2026-09-01T08:18:46Z, both
 * written against `260a6aeea`. At the moment of this snapshot one reported
 * `411d93b40` — the then-current head — and the other still reported
 * `260a6aeea`. Same author, same instant, same original, different `commit_id`,
 * on a PR that took only fast-forward pushes.
 *
 * `PR3610_HEAD` IS THE HEAD AS OF THE SNAPSHOT, deliberately frozen: re-read
 * hours later the same row had moved again, onto `bf323cc71`. That is the point
 * of fact 2 in the module header — the field tracks whatever the head is when
 * you look — so this fixture pins a moment rather than tracking live state,
 * which would make the test assert against a value that changes under it.
 */
const PR3610_HEAD = '411d93b40765dc758b2bcf931f39bab61a2c9a22';
const PR3610_SAME_BATCH = [
  {
    user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: '260a6aeea202bc1234d2241c3ca0e6f3d6c30aa1',
    original_commit_id: '260a6aeea202bc1234d2241c3ca0e6f3d6c30aa1',
    created_at: '2026-09-01T08:18:46Z',
  },
  {
    user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: '411d93b40765dc758b2bcf931f39bab61a2c9a22',
    original_commit_id: '260a6aeea202bc1234d2241c3ca0e6f3d6c30aa1',
    created_at: '2026-09-01T08:18:46Z',
  },
];

/**
 * PR #3389, verbatim. Head is `9c79d14d1`; this row was written against
 * `3b176b9e1` and reports `c85c0f499` — an INTERMEDIATE commit that is neither.
 */
const PR3389_HEAD = '9c79d14d169702e7d142eb001b80b84ca4a1d4dc';
const PR3389_INTERMEDIATE = {
  user: { login: 'coderabbitai[bot]' },
  commit_id: 'c85c0f4994602931dc0f68cca359764c283d38b4',
  original_commit_id: '3b176b9e1350325596c4737b2e8308688b53dc1f',
  created_at: '2026-08-28T11:02:10Z',
};

// ------------------------------------------------- what the fields actually do

test('#3729: `commit_id` reports a head the row was written 88 minutes before', () => {
  // The fixture is the contradiction: the row NAMES the head and PREDATES it.
  assert.equal(PR3719_RELOCATED.commit_id, PR3719_HEAD, 'the relocated field reports the head');
  const anchors = inlineCommentAnchors(PR3719_RELOCATED);
  assert.notEqual(anchors.written, PR3719_HEAD, 'the frozen field does not');
  // AND THE POISONED FIELD IS NOT HANDED BACK. Returning it would leave the bug
  // one destructure away, which is the same reason `normaliseComments` stopped
  // carrying `commitId`.
  assert.deepEqual(Object.keys(anchors).sort(), ['createdAt', 'written']);
  assert.equal(predatesCommit(anchors.createdAt, PR3719_HEAD_COMMITTED_AT), true);
  assert.equal(ageAgainstCommit(anchors.createdAt, PR3719_HEAD_COMMITTED_AT), '88m');
});

test('#3729: `wroteAtCommit` reads the frozen field, so the relocated row does not count', () => {
  assert.equal(wroteAtCommit(PR3719_RELOCATED, PR3719_HEAD), false);
  // ANTI-VACUITY: the identical row with the frozen field AT the head does
  // count. Without this, "always false" passes the assertion above.
  assert.equal(
    wroteAtCommit({ ...PR3719_RELOCATED, original_commit_id: PR3719_HEAD }, PR3719_HEAD),
    true,
  );
});

test('#3729: the trigger is NOT force-push — one batch, one original, two different `commit_id`s', () => {
  // Snapshot rows: see the fixture's note on why the head is frozen here.
  const [stillOriginal, relocated] = PR3610_SAME_BATCH;
  assert.equal(stillOriginal.created_at, relocated.created_at, 'same instant');
  assert.equal(
    stillOriginal.original_commit_id,
    relocated.original_commit_id,
    'same commit reviewed',
  );
  assert.notEqual(stillOriginal.commit_id, relocated.commit_id, 'and yet they now disagree');
  // The field disagrees; the answer does not.
  assert.equal(wroteAtCommit(stillOriginal, PR3610_HEAD), false);
  assert.equal(wroteAtCommit(relocated, PR3610_HEAD), false);
});

test('#3729: `commit_id !== head` is not a sound NEGATIVE either — it can name an intermediate commit', () => {
  // So the field cannot be salvaged by inverting the test: a reader that
  // treated `commit_id !== head` as "written elsewhere" would be right here by
  // luck and wrong on every relocated-to-head row.
  assert.notEqual(PR3389_INTERMEDIATE.commit_id, PR3389_HEAD);
  assert.notEqual(PR3389_INTERMEDIATE.commit_id, PR3389_INTERMEDIATE.original_commit_id);
  assert.equal(wroteAtCommit(PR3389_INTERMEDIATE, PR3389_HEAD), false);
});

// ------------------------------------------------------------- the clock

test('#3729: the clock is a ONE-WAY proof, and the other direction is not hypothetical', () => {
  // PR #3595: head committed 14:48:28Z, two comments created 13 s and 23 s
  // LATER, both written against `68b13a657`. "Created after the head commit"
  // says nothing at all about which commit was read.
  const headCommittedAt = '2026-09-02T14:48:28Z';
  assert.equal(predatesCommit('2026-09-02T14:48:41Z', headCommittedAt), false);
  assert.equal(ageAgainstCommit('2026-09-02T14:48:41Z', headCommittedAt), null);
  // ...while the strictly-earlier direction IS a proof.
  assert.equal(predatesCommit('2026-09-01T05:59:32Z', headCommittedAt), true);
});

test('an unanswerable comparison is `null`, never `false`', () => {
  // ABSENCE MUST NOT READ AS SUCCESS. `false` here would mean "not older than
  // the head", which is what a caller prints as "the clock cannot rule it out"
  // — a statement about a comparison that was never made.
  for (const bad of [undefined, null, '', 'yesterday', {}]) {
    assert.equal(predatesCommit(bad, '2026-09-02T14:48:28Z'), null, JSON.stringify(bad));
    assert.equal(predatesCommit('2026-09-02T14:48:28Z', bad), null, JSON.stringify(bad));
    assert.equal(ageAgainstCommit(bad, '2026-09-02T14:48:28Z'), null, JSON.stringify(bad));
  }
});

test('`isCommitTime` rejects a NUMBER, because `Date.parse("0")` is the year 2000', () => {
  // A VALIDITY CHECK THAT ACCEPTS A WRONG ANSWER IS WORSE THAN NONE. `Date.parse`
  // runs on `String(value)`; `String(0)` is `"0"`, which V8 parses as
  // 2000-01-01. A numeric head-commit time would therefore not refuse — it would
  // silently place the head in the year 2000 and report every review as "not
  // older than the head", which is the exact failure this gate exists to catch.
  assert.equal(Number.isFinite(Date.parse(String(0))), true, 'the hazard is real');
  assert.equal(isCommitTime(0), false);
  assert.equal(isCommitTime(123), false);
  for (const bad of [undefined, null, '', 'yesterday', {}, new Date()]) {
    assert.equal(isCommitTime(bad), false, JSON.stringify(bad));
  }
  assert.equal(isCommitTime('2026-09-02T14:48:28Z'), true);
});

test('the duration reads at every scale it can print', () => {
  const at = (seconds) => new Date(Date.parse('2026-09-02T12:00:00Z') - seconds * 1000).toISOString();
  const head = '2026-09-02T12:00:00Z';
  assert.equal(ageAgainstCommit(at(13), head), '13s');
  assert.equal(ageAgainstCommit(at(89), head), '89s');
  assert.equal(ageAgainstCommit(at(90), head), '2m');
  assert.equal(ageAgainstCommit(at(5280), head), '88m');
  assert.equal(ageAgainstCommit(at(5400), head), '1.5h');
  assert.equal(ageAgainstCommit(at(47 * 3600), head), '47.0h');
  assert.equal(ageAgainstCommit(at(5 * 86400), head), '5.0d');
});

// ------------------------------------------------------------- fail closed

test('FAIL CLOSED: a missing `original_commit_id` refuses rather than falling back', () => {
  // BOTH FALLBACKS ARE WRONG AND NEITHER IS VISIBLE. "Not at head" silently
  // stops counting real findings; "at head" restores the bug. All 75 inline
  // comments on this repository's open PRs carry the field, so an absent one
  // means the payload shape changed.
  for (const bad of [undefined, null, '', 'fecc421e9', 12345]) {
    assert.throws(
      () => inlineCommentAnchors({ ...PR3719_RELOCATED, original_commit_id: bad }),
      (e) => e instanceof ReviewProvenanceError && e.reason === 'UNREADABLE_ANCHOR',
      JSON.stringify(bad),
    );
  }
  // The remedy in the message must not be "use `commit_id`".
  try {
    inlineCommentAnchors({ ...PR3719_RELOCATED, original_commit_id: null });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /do NOT fall back to `commit_id`/);
  }
});

test('an unreadable `commit_id` is NOT fatal on its own — the verdict does not rest on it', () => {
  // A REFUSAL MUST COST SOMETHING THE VERDICT NEEDS. This module discards
  // `commit_id`, so taking a required gate down over it would be a failure
  // caused by a field nothing adjudicates. It still shapes the message when the
  // field that IS needed is missing.
  for (const bad of [undefined, null, '', 'b7352e6d0', 12345]) {
    assert.equal(
      inlineCommentAnchors({ ...PR3719_RELOCATED, commit_id: bad }).written,
      PR3719_RELOCATED.original_commit_id,
      JSON.stringify(bad),
    );
  }
  // …and with BOTH unreadable it refuses, naming that it could not identify the
  // row either.
  try {
    inlineCommentAnchors({ commit_id: null, original_commit_id: null });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof ReviewProvenanceError && e.reason === 'UNREADABLE_ANCHOR');
    assert.match(e.message, /`commit_id` is also unreadable/);
  }
  assert.throws(
    () => inlineCommentAnchors(null),
    (e) => e instanceof ReviewProvenanceError,
  );
});

test('#3729: a NUMERIC timestamp is `null`, not a comparison against the year 2000', () => {
  // `predatesCommit` used to parse `String(value)`; `String(0)` is `"0"`, which
  // V8 reads as 2000-01-01. A numeric `submitted_at` would then have compared
  // as a real date and manufactured a stale finding with a fabricated duration
  // — a validity check that accepts a WRONG answer, which is worse than none.
  assert.equal(predatesCommit(0, PR3719_HEAD_COMMITTED_AT), null);
  assert.equal(predatesCommit(PR3719_HEAD_COMMITTED_AT, 0), null);
  assert.equal(ageAgainstCommit(0, PR3719_HEAD_COMMITTED_AT), null);
});

test('FAIL CLOSED: an unreadable head refuses instead of reporting every row stale', () => {
  for (const bad of [undefined, null, '', 'b7352e6d0', 12345]) {
    assert.throws(
      () => wroteAtCommit(PR3719_RELOCATED, bad),
      (e) => e instanceof ReviewProvenanceError && e.reason === 'NO_HEAD_SHA',
      JSON.stringify(bad),
    );
  }
});
