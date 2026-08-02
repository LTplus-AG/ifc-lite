/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { previewSetPattern, formatMatchHint } from './pattern-preview';

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
});

describe('formatMatchHint', () => {
  it('reads "matches 0 sets in loaded models" for no matches', () => {
    assert.equal(formatMatchHint([]), 'matches 0 sets in loaded models');
  });

  it('singularises one match', () => {
    assert.equal(formatMatchHint(['Qto_WallBaseQuantities']), 'matches 1 set: Qto_WallBaseQuantities');
  });

  it('lists up to the cap then " +N more"', () => {
    assert.equal(formatMatchHint(['A', 'B']), 'matches 2 sets: A, B');
    assert.equal(formatMatchHint(['A', 'B', 'C', 'D', 'E']), 'matches 5 sets: A, B, C +2 more');
  });
});
