/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusModelCases, e2DatasetErrors, loadE2Cases, parseJsonl } from './e2-dataset.mjs';

// What the corpus holds today, pinned independently of the dataset so that a
// discovery bug cannot make both sides empty and agree (corpus.test.ts pins
// the same numbers: 187 pass + 120 fail).
const EXPECTED_COUNTS = { pass: 187, fail: 120 };

const cases = loadE2Cases();
const clone = () => cases.map(record => ({ ...record }));

test('the committed E2 dataset matches the corpus on disk', () => {
  assert.deepEqual(e2DatasetErrors(cases), []);
});

test('the dataset covers every corpus pass-/fail- case once', () => {
  const counts = { pass: 0, fail: 0 };
  for (const record of cases) counts[record.expected]++;
  assert.deepEqual(counts, EXPECTED_COUNTS);
  assert.equal(corpusModelCases().size, EXPECTED_COUNTS.pass + EXPECTED_COUNTS.fail);
});

test('human review is still pending for every description', () => {
  // Flip this when the named review task in worklog/P-08.md is done; until
  // then a `reviewed: true` would be a claim nobody made.
  assert.ok(cases.every(record => record.reviewed === false));
});

test('a dropped case is reported against the corpus', () => {
  const errors = e2DatasetErrors(clone().slice(1));
  assert.deepEqual(errors, [`corpus case ${cases[0].id} has no E2 record`]);
});

test('a flipped verdict, a duplicate and an unknown id are each reported', () => {
  const edited = clone();
  edited[0].expected = edited[0].expected === 'pass' ? 'fail' : 'pass';
  edited.push({ ...edited[1] });
  edited.push({ ...edited[2], id: 'attribute/pass-no_such_case' });
  const errors = e2DatasetErrors(edited);
  assert.ok(errors.some(error => error.includes(cases[0].id) && error.includes('expected should be')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes(cases[1].id) && error.includes('duplicate id')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes('no corpus pass-/fail- case has this id')), errors.join('\n'));
});

test('IDS markup in a description and a wrong ifcVersion are rejected', () => {
  const edited = clone();
  edited[0].description = 'Walls need <simpleValue>Foo</simpleValue> as their name.';
  edited[1].ifcVersion = ['IFC4X3'];
  const errors = e2DatasetErrors(edited);
  assert.ok(errors.some(error => error.includes('IDS/XML markup')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes(cases[1].id) && error.includes('ifcVersion should be')), errors.join('\n'));
});

test('parseJsonl skips blank lines and names the line of a malformed record', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseJsonl('{"a":1}\n{oops}\n'), /line 2/);
});
