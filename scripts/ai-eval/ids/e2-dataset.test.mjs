/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusModelCases, e2DatasetErrors, loadE2Cases, parseJsonl } from './e2-dataset.mjs';
import { assignE2Splits, corpusTestKey, e2SplitGroups, testSplitDigest } from './e2-splits.mjs';

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

// The frozen test split: a digest of its sorted ids. Changing it means the
// headline numbers are no longer comparable with earlier runs, so it needs an
// explicit decision recorded in worklog/P-08.md, not a silent re-shuffle.
const FROZEN_TEST_SPLIT = { cases: 52, digest: 'e5cd33f6d1bfe3383f1d7aacc78fb6c03385f312594393a09daef4b8f3bcf08a' };

test('every E2 case has a split, and the test split is frozen', () => {
  const counts = { train: 0, validation: 0, test: 0 };
  for (const record of cases) counts[record.split]++;
  assert.deepEqual(counts, { train: 188, validation: 67, test: 52 });
  assert.equal(counts.test, FROZEN_TEST_SPLIT.cases);
  assert.equal(testSplitDigest(cases), FROZEN_TEST_SPLIT.digest);
  // Each split holds both verdicts, so agreement on it is not one-sided.
  for (const split of ['train', 'validation', 'test']) {
    for (const expected of ['pass', 'fail']) {
      assert.ok(cases.some(record => record.split === split && record.expected === expected), `${split} has no ${expected} case`);
    }
  }
});

test('the committed splits are the deterministic assignment', () => {
  const assigned = assignE2Splits(cases);
  assert.deepEqual(cases.filter(record => assigned.get(record.id) !== record.split).map(record => record.id), []);
  // File order does not matter.
  const reversed = assignE2Splits([...cases].reverse());
  assert.deepEqual([...reversed].sort(), [...assigned].sort());
});

test('variants of one corpus test and cases sharing a description are one split group', () => {
  assert.equal(corpusTestKey('entity/pass-foo_bar_1_3'), 'entity/foo_bar');
  assert.equal(corpusTestKey('entity/fail-foo_bar_3_3'), 'entity/foo_bar');
  const groups = e2SplitGroups([
    { id: 'entity/pass-foo_1_2', description: 'A' },
    { id: 'entity/fail-foo_2_2', description: 'B' },
    { id: 'entity/pass-other', description: 'B' },
    { id: 'entity/pass-unrelated', description: 'C' },
  ]);
  assert.equal(new Set(groups.values()).size, 2);
  assert.equal(groups.get('entity/pass-other'), groups.get('entity/pass-foo_1_2'));
  assert.notEqual(groups.get('entity/pass-unrelated'), groups.get('entity/pass-foo_1_2'));
});

test('a split leak and an unknown split value are reported', () => {
  const edited = clone();
  const groups = e2SplitGroups(edited);
  const sizes = new Map();
  for (const group of groups.values()) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  const leaked = edited.find(record => sizes.get(groups.get(record.id)) > 1);
  leaked.split = leaked.split === 'test' ? 'train' : 'test';
  edited[0].split = 'holdout';
  const errors = e2DatasetErrors(edited);
  assert.ok(errors.some(error => error.includes('leaks across splits')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes(edited[0].id) && error.includes('split must be one of')), errors.join('\n'));
});
