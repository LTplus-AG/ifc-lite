/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { boundedPassRate, passRateBand } from './pass-rate.js';
import { calculateSummary } from './validator.js';
import type { SpecificationResult } from '../report-types.js';

describe('boundedPassRate (#6470)', () => {
  it('never reads 0% while something passes: 70 of 7,972 is 1%, not 0%', () => {
    expect(boundedPassRate(70, 7972)).toBe(1);
  });

  it('never reads 100% while something fails', () => {
    expect(boundedPassRate(9999, 10000)).toBe(99);
  });

  it('keeps the exact ends and the ordinary floor', () => {
    expect(boundedPassRate(0, 10)).toBe(0);
    expect(boundedPassRate(10, 10)).toBe(100);
    expect(boundedPassRate(1, 3)).toBe(33);
    expect(boundedPassRate(1, 2)).toBe(50);
  });

  it('reads 100 with nothing to measure (0/0), never NaN', () => {
    expect(boundedPassRate(0, 0)).toBe(100);
  });

  it('feeds the summary the issue reported: 70 passed / 7,902 failed', () => {
    const result = { status: 'fail', applicableCount: 7972, passedCount: 70, failedCount: 7902, passRate: 1, entityResults: [] } as unknown as SpecificationResult;
    expect(calculateSummary([result]).overallPassRate).toBe(1);
  });
});

describe('passRateBand', () => {
  it('bands at 80 and 50', () => {
    expect([100, 80, 79, 50, 49, 0].map(passRateBand)).toEqual(['good', 'good', 'warn', 'warn', 'bad', 'bad']);
  });
});
