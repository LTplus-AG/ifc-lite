/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE MATCHER IS INJECTABLE, and this file is the revert oracle's witness for
 * it. The semantic matcher's own tests import a module the revert deletes, so
 * they die at load and prove nothing (REVERT-BROKE-BUILD); this file imports
 * only what survives the revert, and with the old `score(cases)` the injected
 * matcher is never consulted, so the assertions below go red.
 *
 * Its own file, not a case in rubric-eval.test.mjs, because that file reads
 * source text elsewhere and the source-text-assertion gate taints every `s`
 * and `lines` in it -- an edit there trips the gate on seven pre-existing
 * false positives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, score } from './lib/eval-score.mjs';

const expected = { path: 'a.ts', what: 'the thing', class: 'duplicate-site' };
const cases = [
  { pr: 1, body: null, expected: [expected], verdict: 'findings', findings: [{ path: 'a.ts', line: 1, body: 'unrelated prose' }], notApplicable: [] },
  { pr: 2, body: null, expected: [expected, expected], verdict: 'findings', findings: [], notApplicable: [] },
];

test('score() consults the injected matcher once per (case, expected) with its position', () => {
  const seen = [];
  const matcher = (e, findings, body, ctx) => {
    seen.push(`${ctx.caseIndex}:${ctx.expectedIndex}`);
    return ctx.caseIndex === 1 && ctx.expectedIndex === 1 ? { hit: true, by: 'a.ts:9 (P 0.91)' } : { hit: false, by: null };
  };
  const report = score(cases, { matcher });
  assert.deepEqual(seen, ['0:0', '1:0', '1:1']);
  assert.equal(report.hits, 1);
  assert.equal(report.total, 3);
});

test('what the matcher returns in `by` is what the report prints, verbatim', () => {
  const matcher = () => ({ hit: true, by: 'a.ts:9 (P 0.91)' });
  const via = score(cases, { matcher }).lines.map((l) => l.trim()).filter((l) => l.startsWith('via '));
  assert.deepEqual(via, ['via a.ts:9 (P 0.91)', 'via a.ts:9 (P 0.91)', 'via a.ts:9 (P 0.91)']);
});

test('the stem rule stays the default matcher', () => {
  assert.equal(score(cases).hits, 0);
  assert.equal(score(cases, { matcher: matches }).hits, 0);
});
