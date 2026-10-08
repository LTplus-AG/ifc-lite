/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedPassages, passagesOf, verifySpan } from './spans';

/** Deterministic seeded generator (mulberry32) so every failure reproduces. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ['Door', 'fire', 'rating', 'EI30', 'shall', 'be', 'at', 'least', 'Pset_DoorCommon', 'Tür', '🚪', 'FireRating', 'acoustic', '≥', '35', 'dB'];
function specification(seed: number): string {
  const next = seeded(seed);
  const paragraphs = Array.from({ length: 6 }, () => Array.from({ length: 5 + Math.floor(next() * 220) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' '));
  return paragraphs.map((paragraph, index) => (index % 2 ? paragraph.replace(/ /, '\n') : paragraph)).join('\n\n');
}
const payload = (passages: ReturnType<typeof passagesOf>) => JSON.stringify({ evidence: { rows: passages.map((data, index) => ({ citation: `E${index + 1}`, data })) } });

test('#6920 passages keep exact UTF-16 offsets, stay within 500 characters and never split a surrogate pair', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const value = specification(seed);
    const passages = passagesOf('S1', value);
    assert.ok(passages.length >= 6, `seed ${seed}: every paragraph yields a passage`);
    let previousEnd = 0;
    for (const passage of passages) {
      assert.equal(value.slice(passage.start, passage.end), passage.text, `seed ${seed}: offsets reproduce the text`);
      assert.ok(passage.text.length <= 500 && passage.start >= previousEnd, `seed ${seed}: bounded and ordered`);
      assert.ok(!/[\uD800-\uDBFF]$/.test(passage.text) && !/^[\uDC00-\uDFFF]/.test(passage.text), `seed ${seed}: no split surrogate`);
      previousEnd = passage.end;
    }
    // Every non-blank character is covered by exactly one passage.
    const covered = passages.map(passage => passage.text).join('');
    assert.equal(covered.replace(/\s/g, ''), value.replace(/\s/g, ''), `seed ${seed}: nothing dropped or duplicated`);
  }
});

test('#6920 a span verifies only when the captured text at its exact offsets equals the quote', () => {
  const value = 'Scope\n\nDoors in escape routes shall have a fire rating of EI30.\n\nAcoustic: at least 35 dB.';
  const passages = passagesOf('S1', value);
  const start = value.indexOf('fire rating of EI30'); const end = start + 'fire rating of EI30'.length;
  assert.deepEqual(verifySpan({ source: 'S1', start, end, quote: 'fire rating of EI30' }, passages), { status: 'verified' });
  // A shifted quote is a mismatch that reports what the source says, and where the quote really is only as a hint.
  const shifted = verifySpan({ source: 'S1', start: start + 1, end: end + 1, quote: 'fire rating of EI30' }, passages);
  assert.equal(shifted.status, 'mismatch');
  assert.equal(shifted.status === 'mismatch' && shifted.actual, 'ire rating of EI30.');
  assert.equal(shifted.status === 'mismatch' && shifted.foundAt, start);
  // A paraphrase never verifies.
  assert.equal(verifySpan({ source: 'S1', start, end, quote: 'fire resistance of EI30' }, passages).status, 'mismatch');
  // Offsets outside every captured passage, a spanning gap and an unattached source are not captured.
  assert.deepEqual(verifySpan({ source: 'S1', start: 1000, end: 1004, quote: 'abcd' }, passages), { status: 'not-captured' });
  assert.deepEqual(verifySpan({ source: 'S1', start: 0, end: value.length, quote: value }, passages), { status: 'not-captured' });
  assert.deepEqual(verifySpan({ source: 'S2', start, end, quote: 'fire rating of EI30' }, passages), { status: 'not-captured' });
});

test('#6920 a span crossing a long-paragraph break verifies across adjacent captured passages', () => {
  const value = specification(11);
  const passages = passagesOf('S1', value);
  const first = passages.find(passage => passage.text.length > 400 && passages.some(other => other.start === passage.end))!;
  assert.ok(first, 'the seeded text contains a split paragraph');
  const start = first.end - 5; const end = first.end + 5;
  assert.deepEqual(verifySpan({ source: 'S1', start, end, quote: value.slice(start, end) }, passages), { status: 'verified' });
});

test('#6920 only passages frozen in the evidence payload can verify a span', () => {
  const value = 'Doors shall be EI30.';
  const passages = passagesOf('S1', value);
  assert.deepEqual(capturedPassages(payload(passages)), passages);
  // A forged row whose text length disagrees with its offsets is dropped, not trusted.
  assert.deepEqual(capturedPassages(payload([{ ...passages[0], end: passages[0].end + 3 }])), []);
  assert.deepEqual(capturedPassages('not json'), []);
  assert.deepEqual(verifySpan({ source: 'S1', start: 0, end: 5, quote: 'Doors' }, capturedPassages(payload([]))), { status: 'not-captured' });
});
