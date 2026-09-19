/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { previewSetPattern, matchHintFacts } from './pattern-preview';

const SETS = [
  'Qto_WallBaseQuantities',
  'Qto_SlabBaseQuantities',
  'Qto_ColumnBaseQuantities',
  'Pset_WallCommon',
];

describe('previewSetPattern', () => {
  it('lists every discovered set a valid /regex/ matches (the issue #1591 example)', () => {
    const p = previewSetPattern('/Qto_.*BaseQuantities/', SETS);
    assert.equal(p.isPattern, true);
    assert.equal(p.isInvalid, false);
    assert.deepEqual(p.matches, [
      'Qto_WallBaseQuantities',
      'Qto_SlabBaseQuantities',
      'Qto_ColumnBaseQuantities',
    ]);
  });

  it('trims surrounding whitespace before classifying', () => {
    const p = previewSetPattern('  /Pset_.*/  ', SETS);
    assert.equal(p.isPattern, true);
    assert.deepEqual(p.matches, ['Pset_WallCommon']);
  });

  it('is case-sensitive by default, case-insensitive with /i', () => {
    assert.deepEqual(previewSetPattern('/qto_.*/', SETS).matches, []);
    assert.deepEqual(previewSetPattern('/qto_.*/i', SETS).matches, [
      'Qto_WallBaseQuantities',
      'Qto_SlabBaseQuantities',
      'Qto_ColumnBaseQuantities',
    ]);
  });

  it('returns a valid pattern with zero matches (not invalid)', () => {
    const p = previewSetPattern('/Nope_.*/', SETS);
    assert.equal(p.isPattern, true);
    assert.equal(p.isInvalid, false);
    assert.deepEqual(p.matches, []);
  });

  it('treats a plain exact name as neither pattern nor invalid', () => {
    const p = previewSetPattern('Qto_WallBaseQuantities', SETS);
    assert.equal(p.isPattern, false);
    assert.equal(p.isInvalid, false);
    assert.deepEqual(p.matches, []);
  });

  it('flags a slash-shaped literal that does not compile as invalid', () => {
    const p = previewSetPattern('/[unclosed/', SETS);
    assert.equal(p.isPattern, false);
    assert.equal(p.isInvalid, true);
    assert.deepEqual(p.matches, []);
  });

  it('treats an empty / whitespace field as blank (no preview)', () => {
    assert.deepEqual(previewSetPattern('', SETS), { isPattern: false, isInvalid: false, matches: [] });
    assert.deepEqual(previewSetPattern('   ', SETS), { isPattern: false, isInvalid: false, matches: [] });
  });

  it('flags a catastrophic-backtracking-shaped pattern as invalid instead of throwing', () => {
    // `compileNameMatcher` THROWS for this shape (see @ifc-lite/lists, via
    // @ifc-lite/regex-guard). This function runs on every keystroke via the
    // caller's `useMemo` with no surrounding try/catch, so if this call
    // site stopped catching that throw, typing `/(a+)+$/` into the column
    // builder would crash the whole panel mid-keystroke rather than
    // showing the existing "Invalid pattern" warning. Asserting
    // `doesNotThrow` — not just the return value — is what catches that
    // regression.
    assert.doesNotThrow(() => previewSetPattern('/(a+)+$/', SETS));
    const p = previewSetPattern('/(a+)+$/', SETS);
    assert.equal(p.isPattern, false);
    assert.equal(p.isInvalid, true);
    assert.deepEqual(p.matches, []);
  });
});

describe('matchHintFacts', () => {
  it('returns locale-neutral facts for translated match hints', () => {
    assert.deepEqual(matchHintFacts([]), { count: 0, shown: [], extra: 0 });
    assert.deepEqual(matchHintFacts(['A']), { count: 1, shown: ['A'], extra: 0 });
    assert.deepEqual(matchHintFacts(['A', 'B', 'C', 'D', 'E']), {
      count: 5,
      shown: ['A', 'B', 'C'],
      extra: 2,
    });
  });
});
