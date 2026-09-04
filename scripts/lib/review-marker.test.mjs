/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE GRAMMAR AND ITS CONSEQUENCES, PINNED TOGETHER.
 *
 * The token list, the pattern that parses it and the predicate that decides what
 * it buys all live in one module precisely so a new verdict cannot be added to
 * one and forgotten in the others. That is a property, so it is asserted rather
 * than described: `certifiesDiff` is driven from `MARKER_VERDICTS`, never from a
 * hand-written copy of it, and the marker the poster BUILDS is fed to the
 * pattern the gate PARSES.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_RE, MARKER_VERDICTS, certifiesDiff, verdictLines } from './review-marker.mjs';
import { marker, markerVerdict } from '../review/lib/review-findings.mjs';

const SHA = 'a'.repeat(40);

test('every verdict token round-trips: the poster BUILDS it, the gate PARSES it', () => {
  for (const verdict of MARKER_VERDICTS) {
    const m = MARKER_RE.exec(marker(SHA, verdict, 0));
    assert.ok(m, `\`${verdict}\` did not parse`);
    assert.equal(m[1], SHA);
    assert.equal(m[2], verdict, 'the alternation must not truncate a longer token to a shorter prefix');
  }
});

test('`clean-by-judge` is not read as `clean` with a suffix', () => {
  // The one way this grammar could break silently. `clean` sits in the same
  // alternation and is a prefix of `clean-by-judge`, so a pattern that matched
  // it first and stopped would hand the gate the STRONGER verdict for the
  // weaker marker -- granting exactly the stand-down this token exists to
  // withhold.
  const m = MARKER_RE.exec(marker(SHA, 'clean-by-judge', 0));
  assert.equal(m[2], 'clean-by-judge');
  assert.equal(certifiesDiff(m[2]), false);
});

test('the omitted suffix survives on every token', () => {
  for (const verdict of MARKER_VERDICTS) {
    const m = MARKER_RE.exec(marker(SHA, verdict, 0, 3));
    assert.equal(m[4], '3', verdict);
  }
});

test('an INVENTED verdict token does not parse at all', () => {
  // A marker is the only thing that makes this gate green, and its verdict field
  // is not free text. A token nobody defined must read as no marker rather than
  // as an unknown-but-accepted one.
  for (const forged of ['clean-ish', 'reviewed', 'clean-by-nobody', 'CLEAN']) {
    assert.equal(MARKER_RE.exec(marker(SHA, forged, 0)), null, forged);
  }
});

test('certifiesDiff answers for EVERY token, and is true for a strict subset', () => {
  // Driven from the list, so a token added without a decision here shows up as a
  // failure rather than defaulting into whichever branch the code happens to
  // take. Both directions are asserted: a predicate that is true for everything
  // grants the stand-down to markers that earned nothing, and one that is false
  // for everything kills the stand-down entirely and nothing would notice.
  const yes = MARKER_VERDICTS.filter(certifiesDiff);
  assert.deepEqual(yes, ['clean', 'findings']);
  assert.ok(yes.length < MARKER_VERDICTS.length, 'some token must NOT certify, or the label is free');
});

test('markerVerdict only ever returns a token the grammar knows', () => {
  // The poster's decision and the gate's vocabulary, checked against each other.
  const docs = [
    [],
    {},
    { classPass: true },
    { classPass: false },
    { verdict: 'findings', classPass: false },
    { classPass: 'true' },
    null,
  ];
  for (const doc of docs) {
    for (const confirmed of [0, 1, 7]) {
      assert.ok(MARKER_VERDICTS.includes(markerVerdict(doc, confirmed)), JSON.stringify(doc));
    }
  }
});

test('markerVerdict demands the flag be EXACTLY true', () => {
  // `undefined`, `'true'` and `1` are all things a hand-edited or legacy
  // findings.json can carry, and every one of them is silence about a per-class
  // pass. Only the boolean the validator writes buys `clean`.
  assert.equal(markerVerdict({ classPass: true }, 0), 'clean');
  for (const v of [undefined, null, false, 'true', 1, {}]) {
    assert.equal(markerVerdict({ classPass: v }, 0), 'clean-by-judge', JSON.stringify(v) ?? 'undefined');
  }
});

test('verdictLines states FULL=FALSE for exactly the tokens that do not certify', () => {
  for (const verdict of MARKER_VERDICTS) {
    const text = verdictLines({ verdict, count: 0 }, SHA).join('\n');
    assert.equal(
      /FULL=FALSE/.test(text),
      !certifiesDiff(verdict),
      `${verdict}: the prose and the predicate must not disagree`,
    );
  }
});
