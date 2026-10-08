/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW tolerance candidate (#418). The expected bounds are the
 * rows of the upstream table in `Documentation/ImplementersDocumentation/
 * tolerance.md` (IDS 1.0), which the #418 candidate keeps and makes
 * inclusive.
 */

import { describe, expect, it } from 'vitest';
import { equalsWithIds11Tolerance, ids11ToleranceBounds, roundHalfEven } from './tolerance.js';
import { compareNumeric } from '../constraints/comparators.js';

describe('roundHalfEven', () => {
  it('rounds an exact tie to the even digit', () => {
    // 1/65536 = 0.0000152587890625 and 3/65536 = 0.0000457763671875 are
    // exact doubles whose 16th decimal is a lone 5.
    expect(roundHalfEven(1 / 65536, 15)).toBe(0.000015258789062);
    expect(roundHalfEven(3 / 65536, 15)).toBe(0.000045776367188);
    expect(roundHalfEven(-1 / 65536, 15)).toBe(-0.000015258789062);
  });

  it('rounds non-ties to the nearest value', () => {
    expect(roundHalfEven(0.9999979999999999, 15)).toBe(0.999998);
    expect(roundHalfEven(1.0000019999999998, 15)).toBe(1.000002);
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
  });
});

describe('ids11ToleranceBounds (#418 candidate)', () => {
  it.each([
    [100000, 99999.899999, 100000.100001],
    [1, 0.999998, 1.000002],
    [0.001, 0.000998999, 0.001001001],
    [0, -0.000001, 0.000001],
    [-1, -1.000002, -0.999998],
    [-10000, -10000.010001, -9999.989999],
  ])('v = %s gives the upstream table bounds', (v, lower, upper) => {
    expect(ids11ToleranceBounds(v)).toEqual([lower, upper]);
  });

  it('includes both bounds, which the IDS 1.0 text excludes', () => {
    expect(equalsWithIds11Tolerance(1, 1.000002)).toBe(true);
    expect(equalsWithIds11Tolerance(-1, -1.000002)).toBe(true);
    expect(equalsWithIds11Tolerance(1, 1.0000021)).toBe(false);
  });

  it('is used by compareNumeric only when the constraint carries the rule', () => {
    // 1 + 2.0000001e-6 is outside the #418 bounds; the 1.0 comparator's
    // ULP fudge is far smaller than that gap, so both reject it, while a
    // value on the bound itself is accepted by both.
    expect(compareNumeric('1', 1.0000020000001, 'ids11-418')).toBe(false);
    expect(compareNumeric('1', 1.000002, 'ids11-418')).toBe(true);
    expect(compareNumeric('1', 1.000002)).toBe(true);
  });
});
