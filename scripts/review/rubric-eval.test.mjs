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
