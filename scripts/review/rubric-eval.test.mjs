/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The property under test: THIS HARNESS MUST NOT FLATTER A RUBRIC. It exists to
 * decide whether a prose change recovered real recall, so the failure that would
 * make it worthless is a scorer that counts a miss as a hit -- and that is
 * exactly what a loose match would do, since both reviewers are describing the
 * same defect in different words and the temptation is to match loosely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matches, score } from './rubric-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED = {
  path: 'scripts/check-review-posted.mjs',
  what: 'headRepo !== repo compares case-sensitively and can be reached with a null repo, either of which silently disables enforcement',
};

test('a finding describing the SAME defect in different words counts as a hit', () => {
  // Two reviewers will not phrase one defect alike. Demanding they do would score
  // paraphrase rather than recall.
  const m = matches(EXPECTED, [{
    path: 'scripts/check-review-posted.mjs', line: 533,
    body: 'The comparison is case-sensitive, so a differently-cased repo reads as a fork and enforcement is disabled.',
  }]);
  assert.equal(m.hit, true, m.by ?? 'no match');
});

test('a finding in a DIFFERENT file is never a hit, however well it reads', () => {
  const m = matches(EXPECTED, [{ path: 'scripts/other.mjs', line: 1, body: 'case-sensitively disables enforcement' }]);
  assert.equal(m.hit, false);
});

test('ONE shared word is not a match — that is how a scorer flatters a rubric', () => {
  // "enforcement" alone appears in half this repository's prose. Requiring two
  // distinctive terms is what stops a vague finding scoring as a hit.
  const m = matches(EXPECTED, [{ path: EXPECTED.path, line: 533, body: 'something about enforcement here' }]);
  assert.equal(m.hit, false);
});

test('an EMPTY findings list scores zero, not an error', () => {
  const s = score([{ pr: 1, expected: [EXPECTED], verdict: 'clean', findings: [] }]);
  assert.equal(s.hits, 0);
  assert.equal(s.total, 1);
  assert.match(s.recall, /0\/1/);
  assert.ok(s.lines.some((l) => l.includes('❌ MISSED')));
});

test('EXTRA findings are counted and PRINTED, never silently penalised', () => {
  // CodeRabbit's findings are a floor, not a census: an extra may be perfectly
  // real. A harness that scored extras down would train the rubric toward
  // silence, which is the failure it exists to fix.
  const s = score([{
    pr: 1, expected: [EXPECTED], verdict: 'findings',
    findings: [{ path: 'somewhere/else.ts', line: 3, body: 'a different concern' }],
  }]);
  assert.equal(s.extra, 1);
  assert.equal(s.hits, 0, 'and it is not counted as recall');
  assert.ok(s.lines.some((l) => l.includes('➕ EXTRA')));
});

test('recall is reported as a fraction, so a change of denominator is visible', () => {
  const s = score([{ pr: 1, expected: [EXPECTED, { ...EXPECTED, what: 'unrelated thing about pagination truncation' }], verdict: 'findings', findings: [] }]);
  assert.match(s.recall, /0\/2/);
});

// ================================================ the cases are real

test('every eval case is well-formed and carries at least one known finding', () => {
  // A case file with no `expected` would quietly raise recall by shrinking the
  // denominator -- a measurement that improves by measuring less.
  const dir = join(HERE, 'eval-cases');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no cases means a vacuous 0/0');
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.ok(Number.isInteger(c.pr), `${f}: needs the PR it came from`);
    assert.ok(Array.isArray(c.expected) && c.expected.length > 0, `${f}: needs known findings`);
    assert.ok(c.input?.files?.length > 0, `${f}: needs a diff`);
    for (const e of c.expected) {
      assert.ok(
        c.input.files.some((x) => x.path === e.path),
        `${f}: expects a finding in ${e.path}, which is not in the diff`,
      );
    }
  }
});

// ========================= the three ways this scorer was wrong

const E3598 = {
  path: 'scripts/check-review-posted.mjs',
  what: 'the output prints REMEDY: re-run alongside an exemption saying no re-run can clear it: two contradictory remedies',
};

test('GENERIC review vocabulary is not evidence — an unrelated finding is a MISS', () => {
  // THE BUG. `output`, `prints` and `remedy` are ordinary review words, and two
  // of them co-occurring in a finding about something else scored as recall of
  // the contradictory-remedy defect. A rubric that only got noisier would have
  // measured as recovered.
  const m = matches(E3598, [{
    path: E3598.path, line: 340,
    body: 'The renamed helper still prints the old name, so the output disagrees with the code.',
  }]);
  assert.equal(m.hit, false, `scored as a hit via ${m.by}`);
});

test('a finding QUOTING the diff does not thereby match it', () => {
  // `quote` is verbatim source from the diff under review, so folding it in made
  // a finding's own evidence count as agreement. The quote below carries BOTH
  // surviving terms for this case (`exemp`, `contr`) -- if quote were matched,
  // this unrelated finding would score as a full hit.
  const m = matches(E3598, [{
    path: E3598.path, line: 427,
    body: 'This branch is unreachable, so the code here is dead.',
    quote: "'   if (exemption.exempt) { // contradictory branch }'",
  }]);
  assert.equal(m.hit, false, `scored as a hit via ${m.by}`);
});

test('THE STEM IS CALIBRATED IN BOTH DIRECTIONS, not just the tight one', () => {
  // Seven characters lost correct findings to inflection; the fix was five. But
  // a stem can be too SHORT as well, and nothing tested that direction -- a
  // three-character stem left the whole suite green while matching almost
  // anything. `exemp`/`contr` become `exe`/`con`, and this entirely unrelated
  // finding would score as recall of the contradictory-remedy defect.
  const m = matches(E3598, [{
    path: E3598.path, line: 12,
    body: 'The executor connects to the wrong socket when the config is absent.',
  }]);
  assert.equal(m.hit, false, `an unrelated finding scored as a hit via ${m.by}`);
});

test('INFLECTION does not lose a correct finding — that is what reverts a good rubric', () => {
  // "Throwing" does not contain "throws"; "reddens" does not contain "reddeni".
  // A finding that names the defect exactly scored as MISSED, and a miss is the
  // direction that gets a rubric change reverted.
  const expected = {
    path: 'scripts/review/post-review.mjs',
    what: 'WOULD_DOWNGRADE_VERDICT throws, reddening the job for a state that needs no action and that no re-run can clear',
  };
  const m = matches(expected, [{
    path: expected.path, line: 88, class: 'Major',
    body: 'Throwing on WOULD_DOWNGRADE_VERDICT reddens the job for a benign state nobody can clear by re-running. It should log and exit 0.',
  }]);
  assert.equal(m.hit, true, 'a finding naming the defect exactly must count');
});

test('a DIFFERENT finding in the same file is an EXTRA, never silently dropped', () => {
  // The set was built from EXPECTED paths, so a second real defect in a file that
  // also held an expected one vanished: not a hit, not an extra, not printed --
  // in exactly the files a rubric change produces new findings in.
  const s2 = score([{
    pr: 3598, expected: [E3598], verdict: 'findings',
    findings: [{ path: E3598.path, line: 1, body: 'an unrelated pagination truncation bug' }],
  }]);
  assert.equal(s2.hits, 0);
  assert.equal(s2.extra, 1, 'it must be counted');
  assert.ok(s2.lines.some((l) => l.includes('➕ EXTRA')), 'and printed');
});

test('THE HARNESS RUNS THE LANE\'S REAL PIPELINE, both stages', () => {
  // Made twice in one day, in two separate instruments: JSON.parsing the
  // reviewer's RAW output. `run-reviewer.mjs --out` writes raw model text and
  // the model FENCES it -- this harness died on its first live run with
  // "Unexpected token '`', ```json" -- so `validate-findings.mjs` is what parses
  // it. A harness that skips that stage scores a pipeline the lane does not have.
  //
  // Comments are stripped first: the docblock above DISCUSSES both stage names,
  // and an assertion satisfied by prose about the call rather than the call is
  // the shape this repository has paid for repeatedly today.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
  const harness = strip(readFileSync(join(HERE, 'rubric-eval.mjs'), 'utf8'));
  const lane = strip(readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8'));
  for (const stage of ['run-reviewer.mjs', 'validate-findings.mjs']) {
    assert.ok(lane.includes(stage), `the lane must still use ${stage}`);
    assert.ok(harness.includes(stage), `the harness must RUN ${stage}, not merely mention it`);
  }
});
