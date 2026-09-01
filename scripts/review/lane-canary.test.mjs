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
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './lane-canary.mjs';
import { readInput, quotableLines } from './validate-findings.mjs';
import { addedLineRanges, newFileLines } from './build-review-input.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MUST = ['session-timeout', 'timeoutMs'];
// One path, read fresh per test: a second literal is a second thing to drift.
const FIXTURE = join(HERE, 'lane-canary-fixture.json');
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const finding = (extra = {}) => ({
  path: 'src/session-timeout.ts',
  line: 3,
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
  const f = fixture();
  const patch = f.files[0].patch;
  assert.match(patch, /Number\(raw\)/, 'the NaN source');
  assert.match(patch, /timeoutMs > 0/, 'the one-ended bound');
  assert.match(patch, /return 0;/, 'the destructive fall-through');
  assert.equal(f.files[0].path, 'src/session-timeout.ts');
  // And the strings the judge requires must be present in the diff, or the
  // canary is asking for something the reviewer could not say.
  for (const m of MUST) assert.ok(JSON.stringify(f).includes(m), `fixture must contain ${m}`);
});

test('the fixture\'s ranges are what the BUILDER emits, and the quote is where it says', () => {
  // `validate-findings.mjs` refuses any finding whose line falls outside an added
  // range, so a fixture whose ranges miss the defect makes a CORRECT review fail
  // validation and the canary blames the reviewer.
  //
  // Both numbers are DERIVED, and derived from the LANE'S OWN counter. Written
  // down by hand they were both wrong and nothing noticed: the ranges said
  // `[[2, 8]]` where the builder emits `[[2, 7]]` -- new-file line 8 is the
  // trailing `}`, a context line -- so the frozen fixture was LOOSER than any
  // real review input and would have certified a finding on a line the PR never
  // added. The quote's line was written as 4 in two places; it is 3.
  //
  // The first repair walked the patch here instead, which was the same mistake
  // one level up: a second counter agrees with the builder on the easy patch it
  // was written against and diverges on a hunk that does not start at line 1, on
  // a second hunk, and on a file with no trailing newline -- and in each case
  // lands INSIDE a valid range, so both assertions pass while certifying an
  // off-by-one. `newFileLines` is now the one counter that `addedLineRanges` is
  // itself built on.
  const f = fixture();
  const patch = f.files[0].patch;
  assert.deepEqual(
    f.files[0].addedLineRanges,
    addedLineRanges(patch),
    'the fixture must be a shape the builder can actually produce',
  );

  // Matched the way the LANE matches: `quotableLines` compares trimmed text and
  // ignores diff metadata. Exact untrimmed equality here would be stricter than
  // the gate it mirrors, so a trailing space or a CRLF fixture would redden this
  // test while the real canary run stayed green -- a false alarm on the
  // instrument whose whole purpose is that a fixture the pipeline refuses must
  // not be mistaken for a reviewer that stopped working.
  const want = finding().quote.trim();
  const hits = newFileLines(patch).filter((l) => l.kind === 'added' && l.text.trim() === want);
  assert.equal(hits.length, 1, 'the quote must identify exactly one ADDED line, or its position is ambiguous');
  assert.equal(hits[0].line, finding().line, 'the finding\'s line must be where its quote actually is');
  assert.ok(quotableLines(patch).includes(want), 'and the lane\'s own matcher must accept it');
});

test('THE CANARY RUNS THE LANE\'S REAL PIPELINE, not a shortcut past it', () => {
  // Its first live run failed BAD_OUTPUT because it JSON.parsed the reviewer's
  // RAW text. `run-reviewer.mjs --out` writes raw model output; it is
  // `validate-findings.mjs` that parses it, strips fencing, checks quotes
  // against the diff and drops unanchored findings.
  //
  // So the canary was exercising a pipeline the lane does not have. A canary on
  // a different path from the thing it watches is worth less than none, and this
  // asserts the two stay the same shape. Static, because the alternative is a
  // live model call per test run.
  // COMMENTS STRIPPED FIRST. The first version of this assertion matched the
  // string anywhere in the file, and the docblock above DISCUSSES
  // `validate-findings.mjs` -- so deleting the actual call left the test green.
  // A check satisfied by prose about the thing, rather than the thing, is the
  // defect this repository has now paid for four times in one day.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
  const canary = strip(readFileSync(join(HERE, 'lane-canary.mjs'), 'utf8'));
  const lane = strip(readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8'));
  for (const stage of ['run-reviewer.mjs', 'validate-findings.mjs']) {
    assert.ok(lane.includes(stage), `the lane must still use ${stage}`);
    assert.ok(canary.includes(stage), `the canary must RUN ${stage}, not merely mention it`);
  }
});

test('THE FIXTURE PASSES THE VALIDATOR THE LANE ACTUALLY RUNS, and it can still refuse', () => {
  // The canary's third failure was a fixture the pipeline refused before the
  // reviewer's verdict could be judged: `headSha` was `canary000...ca`, which
  // reads well and is not hex. A fixture that cannot pass the pipeline it is fed
  // to makes the canary permanently red for a reason that has nothing to do with
  // the reviewer, which is how an alarm gets muted.
  //
  // `readInput` is called rather than re-checking the sha with a copied regex, so
  // the assertion cannot drift from what the lane enforces. On THIS fixture the
  // rules with teeth are the sha, non-empty `files`, and range shape; the
  // duplicate-path and files/unreviewable-overlap rules are vacuous here because
  // there is one file and `unreviewable` is empty. It is exercised in both
  // directions, because an assertion that only ever sees a pass would stay green
  // if `readInput` stopped refusing anything at all.
  assert.doesNotThrow(() => readInput(FIXTURE));

  const bad = fixture();
  bad.headSha = 'canary00000000000000000000000000000000ca';
  const tmp = join(mkdtempSync(join(tmpdir(), 'canary-fx-')), 'bad.json');
  writeFileSync(tmp, JSON.stringify(bad));
  assert.throws(() => readInput(tmp), (e) => e.reason === 'INPUT_INVALID');
});
