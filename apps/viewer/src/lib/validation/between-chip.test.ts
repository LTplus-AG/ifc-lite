/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `between` fold/unfold (#5138 plan §6's operator table): a `gte` rule and
 * an `lte` rule on the identical subject fold into one display chip, and
 * unfolding reverses it back to the exact two-rule pair `rule-set-io.ts`
 * persists — "between chip emits gte+lte, reloads as one chip" is this
 * round-trip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldBetweenPairs, unfoldBetweenChips, isBetweenChip } from './between-chip.js';
import { Rule, type FilterRule } from '../search/filter-rules.js';

describe('between-chip fold/unfold (#5138)', () => {
  it('folds a gte+lte pair on the same quantity into one chip', () => {
    const gte = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 100);
    const lte = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lte', 300);
    const folded = foldBetweenPairs([gte, lte]);
    assert.equal(folded.length, 1);
    assert.ok(isBetweenChip(folded[0]));
    if (isBetweenChip(folded[0])) {
      assert.equal(folded[0].min.value, 100);
      assert.equal(folded[0].max.value, 300);
    }
  });

  it('unfolding a chip emits exactly the gte rule then the lte rule', () => {
    const gte = Rule.property('Pset_WallCommon', 'FireRating', 'gte', '2');
    const lte = Rule.property('Pset_WallCommon', 'FireRating', 'lte', '4');
    const folded = foldBetweenPairs([gte, lte]);
    const unfolded = unfoldBetweenChips(folded);
    assert.deepEqual(unfolded, [gte, lte]);
  });

  it('reloading unfolded rules folds back into one chip (round-trip)', () => {
    const gte = Rule.attribute('Tag', 'gte', '10');
    const lte = Rule.attribute('Tag', 'lte', '20');
    const first = foldBetweenPairs([gte, lte]);
    const reloaded = foldBetweenPairs(unfoldBetweenChips(first));
    assert.equal(reloaded.length, 1);
    assert.ok(isBetweenChip(reloaded[0]));
  });

  it('does not fold a lone gte, a lone lte, or a mismatched subject', () => {
    const gteOnly = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 100);
    assert.equal(foldBetweenPairs([gteOnly]).length, 1);
    assert.equal(isBetweenChip(foldBetweenPairs([gteOnly])[0]), false);

    const gteA = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 100);
    const lteB = Rule.quantity('Qto_WallBaseQuantities', 'Length', 'lte', 300);
    const folded = foldBetweenPairs([gteA, lteB]);
    assert.equal(folded.length, 2);
    assert.equal(folded.some(isBetweenChip), false);
  });

  it('does not fold kinds without a numeric bound (ifcType/name/etc.)', () => {
    const rules: FilterRule[] = [Rule.ifcType(['IfcWall'], 'in'), Rule.name('contains', 'Wall')];
    const folded = foldBetweenPairs(rules);
    assert.deepEqual(folded, rules);
  });

  it('preserves rule order around a folded pair', () => {
    const before = Rule.name('contains', 'Wall');
    const gte = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 100);
    const lte = Rule.quantity('Qto_WallBaseQuantities', 'Width', 'lte', 300);
    const after = Rule.material('contains', 'Concrete');
    const folded = foldBetweenPairs([before, gte, after, lte]);
    // `after` sits between the pair in source order; the pair still folds
    // (order-independent search), and the chip lands where the `gte` was.
    assert.equal(folded.length, 3);
    assert.deepEqual(folded[0], before);
    assert.ok(isBetweenChip(folded[1]));
    assert.deepEqual(folded[2], after);
  });
});
