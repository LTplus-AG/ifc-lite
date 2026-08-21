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

test('no comment at all is NO-REVIEW and not reviewed', () => {
  const r = classifyReviewState({ bodies: [], inlineThreadCount: 0 });
  assert.equal(r.state, 'NO-REVIEW');
  assert.equal(r.reviewed, false);
});

test('sentinel with zero inline threads is UNREVIEWED', () => {
  const r = classifyReviewState({ bodies: [sentinelBody], inlineThreadCount: 0 });
  assert.equal(r.state, 'UNREVIEWED');
  assert.equal(r.reviewed, false);
});

test('sentinel WITH inline threads is a stale summary, not an unreviewed PR', () => {
  // The case that defeats a sentinel-only detector: the summary comment says
  // rate limited, but findings were posted afterwards and never folded in.
  const r = classifyReviewState({ bodies: [sentinelBody], inlineThreadCount: 2 });
  assert.equal(r.state, 'STALE-SUMMARY');
  assert.equal(
    r.reviewed,
    true,
    'inline findings prove a review ran, whatever the summary says',
  );
});

test('a named file list counts as a real review', () => {
  const r = classifyReviewState({ bodies: [realReviewBody], inlineThreadCount: 0 });
  assert.equal(r.state, 'REVIEWED');
  assert.equal(r.reviewed, true);
});

test('a Run ID counts as a real review', () => {
  const r = classifyReviewState({ bodies: [runIdBody], inlineThreadCount: 0 });
  assert.equal(r.state, 'REVIEWED');
});

test('inline threads alone count as a real review', () => {
  const r = classifyReviewState({ bodies: ['ack'], inlineThreadCount: 1 });
  assert.equal(r.state, 'REVIEWED');
});

test('a comment carrying none of the three markers is INCONCLUSIVE, not a failure', () => {
  // Refusing to call this unreviewed matters: guessing here would flag real
  // reviews and the report would stop being believed.
  const r = classifyReviewState({ bodies: ['thanks!'], inlineThreadCount: 0 });
  assert.equal(r.state, 'INCONCLUSIVE');
  assert.equal(r.reviewed, true);
});

test('the sentinel is matched inside a larger body, not only as a whole comment', () => {
  const buried = `intro\n\nmore text\n<!-- ${RATE_LIMIT_SENTINEL} -->\n\ntrailer`;
  assert.equal(
    classifyReviewState({ bodies: [buried], inlineThreadCount: 0 }).state,
    'UNREVIEWED',
  );
});

test('one sentinel among several comments is enough to consider the limit hit', () => {
  const r = classifyReviewState({
    bodies: ['earlier chatter', sentinelBody],
    inlineThreadCount: 0,
  });
  assert.equal(r.state, 'UNREVIEWED');
});

test('a missing inlineThreadCount is treated as zero rather than throwing', () => {
  const r = classifyReviewState({ bodies: [sentinelBody] });
  assert.equal(r.state, 'UNREVIEWED');
});
