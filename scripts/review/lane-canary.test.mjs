/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The property under test: THIS CANARY MUST NOT GO GREEN ON A LANE THAT IS NOT
 * REVIEWING. Every case below is a way a broken or lazy reviewer could look fine
 * to a weaker judge -- an empty findings list, a `clean` verdict, findings about
 * something else entirely.
 *
 * The canary is itself an instrument, and an instrument nobody checks is the
 * thing this repository keeps paying for. So it is exercised in BOTH directions:
 * the passing case is here too, or every assertion below would be satisfied by a
 * judge that always fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './lane-canary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MUST = ['session-timeout', 'timeoutMs'];
const finding = (extra = {}) => ({
  path: 'src/session-timeout.ts',
  line: 4,
  quote: '  if (timeoutMs > 0) {',
  body: 'Number(undefined) is NaN and NaN > 0 is false, so this returns 0 and closes the session.',
  class: 'numeric-bound',
  ...extra,
});

test('THE PASSING CASE: findings that name the planted defect', () => {
  const v = judge({ verdict: 'findings', findings: [finding()] }, MUST);
  assert.equal(v.ok, true, v.why);
});

test('a CLEAN verdict is a FAILURE — that is the whole point of the canary', () => {
  // A token ping proves authentication. It does not prove the reviewer still
  // reviews: a rubric edit or a truncated prompt leaves a lane that answers
  // cleanly and finds nothing, and every per-PR check still looks normal.
  const v = judge({ verdict: 'clean', findings: [] }, MUST);
  assert.equal(v.ok, false);
  assert.match(v.why, /answering, not reviewing/);
});

test('`findings` with an EMPTY list contradicts itself and fails', () => {
  const v = judge({ verdict: 'findings', findings: [] }, MUST);
  assert.equal(v.ok, false);
  assert.match(v.why, /EMPTY findings list/);
});

test('findings about something ELSE do not count as finding THIS one', () => {
  // Without this, a reviewer that had started hallucinating would keep the
  // canary green: any non-empty list would pass.
  const v = judge(
    { verdict: 'findings', findings: [finding({ path: 'src/unrelated.ts', quote: 'const x = 1;', body: 'nit' })] },
    MUST,
  );
  assert.equal(v.ok, false);
  assert.match(v.why, /none names/);
});

test('a PARTIAL match still fails: naming the file is not naming the defect', () => {
  const v = judge(
    { verdict: 'findings', findings: [{ path: 'src/session-timeout.ts', body: 'looks fine to me' }] },
    MUST,
  );
  assert.equal(v.ok, false, 'mentions the file but never the symbol the defect is in');
});

test('a non-object response fails rather than throwing', () => {
  for (const bad of [null, 'clean', 42, undefined]) {
    assert.equal(judge(bad, MUST).ok, false, JSON.stringify(bad));
  }
});

// ============================================== the fixture is the ground truth

test('THE FIXTURE ACTUALLY CONTAINS THE DEFECT the canary demands be found', () => {
  // If the fixture were ever edited to remove the bug, the canary would demand a
  // finding that is not there and go permanently red -- a false alarm that would
  // then be "fixed" by weakening the judge. Pin the input, not just the output.
  const f = JSON.parse(readFileSync(join(HERE, 'lane-canary-fixture.json'), 'utf8'));
  const patch = f.files[0].patch;
  assert.match(patch, /Number\(raw\)/, 'the NaN source');
  assert.match(patch, /timeoutMs > 0/, 'the one-ended bound');
  assert.match(patch, /return 0;/, 'the destructive fall-through');
  assert.equal(f.files[0].path, 'src/session-timeout.ts');
  // And the strings the judge requires must be present in the diff, or the
  // canary is asking for something the reviewer could not say.
  for (const m of MUST) assert.ok(JSON.stringify(f).includes(m), `fixture must contain ${m}`);
});

test('the added-line ranges cover the defect, or the validator would reject the finding', () => {
  // `validate-findings.mjs` refuses any finding whose line falls outside an added
  // range. A fixture whose ranges miss the defect would make a CORRECT review
  // fail validation, and the canary would blame the reviewer.
  const f = JSON.parse(readFileSync(join(HERE, 'lane-canary-fixture.json'), 'utf8'));
  const [[lo, hi]] = f.files[0].addedLineRanges;
  assert.ok(lo <= 4 && 4 <= hi, `the guard is on line 4; ranges are ${lo}..${hi}`);
});
