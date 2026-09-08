// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReviewState,
  RATE_LIMIT_SENTINEL,
} from './coderabbit-review-state.mjs';

// Synthetic bodies only -- no real comment text is asserted on, per
// scripts/check-source-text-assertions.mjs.
const sentinelBody = `Some summary text.\n<!-- ${RATE_LIMIT_SENTINEL} -->\nReview limit reached.`;
const realReviewBody = 'Files selected for processing (3)\n- a.ts\n- b.ts\n- c.ts';
const runIdBody = 'Review completed. Run ID: c78736ee1234abcd.';

// The head commit, and a review that landed after it. Tests about the CONTENT
// signals pass these so they pin content and nothing else; the tests about time
// vary them deliberately.
const PUSHED_AT = '2026-08-20T10:00:00Z';
const AFTER_PUSH = '2026-08-20T10:04:00Z';
const BEFORE_PUSH = '2026-08-01T09:00:00Z';

/** A review that is current: whatever `overrides` say, dated after the push. */
const atHead = (overrides) => ({
  latestReviewAt: AFTER_PUSH,
  headCommitAt: PUSHED_AT,
  ...overrides,
});

test('no comment at all AND no inline thread is NO-REVIEW and not reviewed', () => {
  const r = classifyReviewState(atHead({ bodies: [], inlineThreadCount: 0 }));
  assert.equal(r.state, 'NO-REVIEW');
  assert.equal(r.reviewed, false);
});

test('inline threads with NO comment body are a review, not a NO-REVIEW', () => {
  // The false-negative direction. CodeRabbit can leave inline findings while
  // its summary comment is absent or has been deleted; three open threads are
  // positive evidence that a review ran, so an empty body list must not
  // short-circuit past the thread count.
  const r = classifyReviewState(atHead({ bodies: [], inlineThreadCount: 3 }));
  assert.equal(r.state, 'REVIEWED');
  assert.equal(
    r.reviewed,
    true,
    'three inline findings exist; the tool must not report that no review ran',
  );
});

test('sentinel with zero inline threads is UNREVIEWED', () => {
  const r = classifyReviewState(
    atHead({ bodies: [sentinelBody], inlineThreadCount: 0 }),
  );
  assert.equal(r.state, 'UNREVIEWED');
  assert.equal(r.reviewed, false);
});

test('sentinel WITH inline threads is a stale summary, not an unreviewed PR', () => {
  // The case that defeats a sentinel-only detector: the summary comment says
  // rate limited, but findings were posted afterwards and never folded in.
  const r = classifyReviewState(
    atHead({ bodies: [sentinelBody], inlineThreadCount: 2 }),
  );
  assert.equal(r.state, 'STALE-SUMMARY');
  assert.equal(
    r.reviewed,
    true,
    'inline findings prove a review ran, whatever the summary says',
  );
});

test('a named file list counts as a real review', () => {
  const r = classifyReviewState(
    atHead({ bodies: [realReviewBody], inlineThreadCount: 0 }),
  );
  assert.equal(r.state, 'REVIEWED');
  assert.equal(r.reviewed, true);
});

test('a Run ID counts as a real review', () => {
  const r = classifyReviewState(
    atHead({ bodies: [runIdBody], inlineThreadCount: 0 }),
  );
  assert.equal(r.state, 'REVIEWED');
});

test('inline threads alone count as a real review', () => {
  const r = classifyReviewState(atHead({ bodies: ['ack'], inlineThreadCount: 1 }));
  assert.equal(r.state, 'REVIEWED');
});

test('a comment carrying none of the markers is INCONCLUSIVE and NOT reviewed', () => {
  // Ambiguity resolves to the unreviewed answer. A false "not reviewed" is
  // loud and self-correcting -- someone opens the PR and sees the review. A
  // false "reviewed" is silent and terminal: nobody looks again, and this tool
  // has certified the exact thing it exists to catch.
  const r = classifyReviewState(atHead({ bodies: ['thanks!'], inlineThreadCount: 0 }));
  assert.equal(r.state, 'INCONCLUSIVE');
  assert.equal(r.reviewed, false);
});

test('the sentinel is matched inside a larger body, not only as a whole comment', () => {
  const buried = `intro\n\nmore text\n<!-- ${RATE_LIMIT_SENTINEL} -->\n\ntrailer`;
  assert.equal(
    classifyReviewState(atHead({ bodies: [buried], inlineThreadCount: 0 })).state,
    'UNREVIEWED',
  );
});

test('one sentinel among several comments is enough to consider the limit hit', () => {
  const r = classifyReviewState(
    atHead({ bodies: ['earlier chatter', sentinelBody], inlineThreadCount: 0 }),
  );
  assert.equal(r.state, 'UNREVIEWED');
});

test('a missing inlineThreadCount is treated as zero rather than throwing', () => {
  const r = classifyReviewState(atHead({ bodies: [sentinelBody] }));
  assert.equal(r.state, 'UNREVIEWED');
});

// --- time -------------------------------------------------------------------
// Content signals say a review happened. They never say WHICH diff it read.

test('a review older than the head commit does not cover it', () => {
  // The false-positive direction, and the one the tool exists to catch: the
  // findings are real, the tick is green, and every one of them is about a diff
  // that was replaced by the last push.
  const r = classifyReviewState({
    bodies: [realReviewBody],
    inlineThreadCount: 1,
    latestReviewAt: BEFORE_PUSH,
    headCommitAt: PUSHED_AT,
  });
  assert.equal(r.state, 'PRE-PUSH-REVIEW');
  assert.equal(r.reviewed, false);
});

test('a review after the head commit does cover it', () => {
  // The mirror mistake to guard against while fixing the one above: a PR that
  // genuinely was reviewed at its current head must still read REVIEWED, or the
  // freshness gate has reintroduced the false negative from the other side.
  const r = classifyReviewState({
    bodies: [realReviewBody],
    inlineThreadCount: 2,
    latestReviewAt: AFTER_PUSH,
    headCommitAt: PUSHED_AT,
  });
  assert.equal(r.state, 'REVIEWED');
  assert.equal(r.reviewed, true);
});

test('a stale summary is still gated on time like any other evidence', () => {
  // STALE-SUMMARY is a `reviewed: true` state, so it is a route to the silent
  // mistake too: sentinel plus findings, all of it from before the last push.
  const r = classifyReviewState({
    bodies: [sentinelBody],
    inlineThreadCount: 2,
    latestReviewAt: BEFORE_PUSH,
    headCommitAt: PUSHED_AT,
  });
  assert.equal(r.state, 'PRE-PUSH-REVIEW');
  assert.equal(r.reviewed, false);
});

test('a missing review timestamp is UNDATED and not reviewed', () => {
  // Stated decision, not an accident: GitHub can return no usable instant, and
  // the answer on absence of evidence is the unreviewed one.
  for (const latestReviewAt of [undefined, null, '']) {
    const r = classifyReviewState({
      bodies: [realReviewBody],
      inlineThreadCount: 1,
      latestReviewAt,
      headCommitAt: PUSHED_AT,
    });
    assert.equal(r.state, 'UNDATED', `latestReviewAt=${String(latestReviewAt)}`);
    assert.equal(r.reviewed, false, `latestReviewAt=${String(latestReviewAt)}`);
  }
});

test('a missing head-commit timestamp is UNDATED and not reviewed', () => {
  // `pushedDate` is null on many commits and `committedDate` can be absent
  // too, so this is the likelier of the two gaps in practice.
  const r = classifyReviewState({
    bodies: [realReviewBody],
    inlineThreadCount: 1,
    latestReviewAt: AFTER_PUSH,
    headCommitAt: null,
  });
  assert.equal(r.state, 'UNDATED');
  assert.equal(r.reviewed, false);
});

test('an unparseable timestamp is UNDATED, not silently treated as fresh', () => {
  // Every comparison against NaN is false in BOTH directions, so a bare `<`
  // would fall through to the "new enough" branch and certify the PR on a
  // garbage string. Pinned so that shortcut cannot be reintroduced.
  const garbage = 'not-a-date';
  assert.equal(
    classifyReviewState({
      bodies: [realReviewBody],
      inlineThreadCount: 1,
      latestReviewAt: garbage,
      headCommitAt: PUSHED_AT,
    }).reviewed,
    false,
  );
  assert.equal(
    classifyReviewState({
      bodies: [realReviewBody],
      inlineThreadCount: 1,
      latestReviewAt: AFTER_PUSH,
      headCommitAt: garbage,
    }).reviewed,
    false,
  );
});

test('inline threads without a body are gated on time too', () => {
  // The two fixes must compose: recognising thread-only evidence must not hand
  // that evidence a free pass on freshness.
  const r = classifyReviewState({
    bodies: [],
    inlineThreadCount: 3,
    latestReviewAt: BEFORE_PUSH,
    headCommitAt: PUSHED_AT,
  });
  assert.equal(r.state, 'PRE-PUSH-REVIEW');
  assert.equal(r.reviewed, false);
});

test('a PR with no review at all is NO-REVIEW even when undated', () => {
  // Timestamps are only consulted once something claims a review happened;
  // an unreviewable PR must not be relabelled UNDATED, which would lose the
  // more specific reason.
  const r = classifyReviewState({ bodies: [], inlineThreadCount: 0 });
  assert.equal(r.state, 'NO-REVIEW');
  assert.equal(r.reviewed, false);
});
