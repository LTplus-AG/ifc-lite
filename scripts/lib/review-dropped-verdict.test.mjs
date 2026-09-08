/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two halves of `verdict=dropped`, tested where they now live. The gate's
 * own suite still drives `evaluate` and the marker end to end; this file pins
 * the pieces that moved so the split cannot quietly change what they say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { droppedVerdict, shouldKeepPolling } from './review-dropped-verdict.mjs';
import { MARKER_RE, MARKER_SHAPE } from './review-marker.mjs';

const SHA = 'a'.repeat(40);

test('droppedVerdict is NOT ok, NOT full, and terminal', () => {
  const r = droppedVerdict(SHA);
  assert.equal(r.ok, false, 'covered=ok, and a dropped head must stay uncovered');
  assert.equal(r.full, false, 'CodeRabbit must not stand down on it');
  assert.equal(r.terminal, true, 'the lane job that wrote it has exited');
  assert.equal(r.verdict, 'FINDINGS_ALL_DROPPED');
  assert.equal(r.escapeHatch, null);
});

test('droppedVerdict names the head and a remedy a re-run can carry out', () => {
  const text = droppedVerdict(SHA).lines.join('\n');
  assert.match(text, new RegExp(SHA.slice(0, 9)));
  assert.match(text, /REMEDY: re-run the review job/);
  // The distinction the whole verdict exists to make.
  assert.match(text, /NOT a verdict on the/);
});

test('shouldKeepPolling stops on terminal, waits on absence, and never waits on a pass', () => {
  assert.equal(shouldKeepPolling(droppedVerdict(SHA)), false);
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'NOT_POSTED' }), true);
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'STALE_REVIEW' }), true);
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'FINDINGS_NOT_POSTED' }), true);
  assert.equal(shouldKeepPolling({ ok: true, verdict: 'REVIEW_POSTED' }), false);
});

test('MARKER_RE accepts every verdict MARKER_SHAPE advertises, and nothing else', () => {
  // The pattern and the sentence that tells an author how to fix a bad marker
  // are the same fact. Spelled twice, a new verdict could be accepted by one and
  // absent from the other, and the remedy would name a form the gate rejects.
  const advertised = MARKER_SHAPE.match(/verdict=([a-z|-]+)/)[1].split('|');
  // Spelled out rather than compared to `MARKER_VERDICTS`: MARKER_SHAPE is built
  // from that array, so the two would agree by construction and the check would
  // certify nothing. `clean-by-judge` leads because the alternation is
  // longest-prefix-first (#3862).
  assert.deepEqual(advertised, ['clean-by-judge', 'clean', 'findings', 'nothing-to-review', 'dropped']);
  for (const v of advertised) {
    const m = MARKER_RE.exec(`<!-- ifc-lite-review sha=${SHA} verdict=${v} count=0 -->`);
    assert.ok(m, `MARKER_RE must accept the advertised verdict \`${v}\``);
    assert.equal(m[2], v);
  }
  assert.equal(MARKER_RE.exec(`<!-- ifc-lite-review sha=${SHA} verdict=invented count=0 -->`), null);
});
