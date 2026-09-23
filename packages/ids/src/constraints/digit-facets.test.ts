/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { countDecimalDigits, matchDigitFacets } from './digit-facets.js';
import { getConstraintMismatchReason } from './describe.js';

/**
 * `matchDigitFacets` only exposes pass/fail, not the underlying
 * `{ total, fraction }` pair — pin the exact count by bracketing it:
 * the facet value itself must pass, and one below it must fail.
 */
function exactDigitCounts(actualValue: string | number, total: number, fraction: number) {
  expect(matchDigitFacets({ totalDigits: total }, actualValue)).toBe(true);
  expect(matchDigitFacets({ totalDigits: total - 1 }, actualValue)).toBe(false);
  expect(matchDigitFacets({ fractionDigits: fraction }, actualValue)).toBe(true);
  if (fraction > 0) {
    expect(matchDigitFacets({ fractionDigits: fraction - 1 }, actualValue)).toBe(false);
  }
}

// ============================================================================
// matchDigitFacets — exponential strings, exact digit counts (#5186)
// ============================================================================

describe('matchDigitFacets — exponential-notation strings, exact counts', () => {
  it('normalises a lowercase exponent: 1.5e3 === 1500 -> {4, 0}', () => {
    exactDigitCounts('1.5e3', 4, 0);
  });

  it('normalises an uppercase exponent identically: 1E3 === 1000 -> {4, 0}', () => {
    exactDigitCounts('1E3', 4, 0);
  });

  it('normalises a negative exponent: 1.5e-3 === 0.0015 -> {2, 4}', () => {
    exactDigitCounts('1.5e-3', 2, 4);
  });
});

// ============================================================================
// countDecimalDigits — fixed-point no-regression pins (#5186)
// ============================================================================

describe('countDecimalDigits — fixed-point pins (must not shift)', () => {
  it.each([
    ['0012.3400', { total: 4, fraction: 2 }],
    ['0.0025', { total: 2, fraction: 4 }],
    ['1.4500', { total: 3, fraction: 2 }],
    ['1000', { total: 4, fraction: 0 }],
    ['-0012.3400', { total: 4, fraction: 2 }],
  ] as const)('%s -> %o', (input, expected) => {
    expect(countDecimalDigits(input)).toEqual(expected);
  });
});

// ============================================================================
// matchDigitFacets — string vs number parity (#5186)
// ============================================================================

describe('matchDigitFacets — exponential string actualValue', () => {
  it('passes a fractionDigits bound against an exponential string', () => {
    // 1.5e3 === 1500, canonically 0 fraction digits.
    expect(matchDigitFacets({ fractionDigits: 1 }, '1.5e3')).toBe(true);
  });

  it('matches the equivalent number for the same magnitude', () => {
    expect(matchDigitFacets({ fractionDigits: 1 }, 1500)).toBe(true);
    expect(matchDigitFacets({ totalDigits: 4 }, 1500)).toBe(
      matchDigitFacets({ totalDigits: 4 }, '1.5e3')
    );
  });

  it('still rejects a non-numeric string', () => {
    expect(matchDigitFacets({ totalDigits: 4 }, '2022-01-01')).toBe(false);
  });
});

// ============================================================================
// Exponent applied on the lexical digits, not through a double (#5186)
// ============================================================================

describe('countDecimalDigits — exponential literals are counted exactly', () => {
  it.each([
    ['1.5e3', { total: 4, fraction: 0 }],
    ['1E3', { total: 4, fraction: 0 }],
    ['+1.5E+3', { total: 4, fraction: 0 }],
    ['-2.50e-2', { total: 2, fraction: 3 }],
    ['.5e1', { total: 1, fraction: 0 }],
    ['0012.3400e0', { total: 4, fraction: 2 }],
    ['0e5', { total: 1, fraction: 0 }],
    ['1e-7', { total: 1, fraction: 7 }],
  ] as const)('%s -> %o', (input, expected) => {
    expect(countDecimalDigits(input)).toEqual(expected);
  });

  it('keeps precision a double cannot hold: 21 significant digits', () => {
    // 123456.789012345678901 — parseFloat would round this to ~17 digits.
    expect(countDecimalDigits('1.23456789012345678901e5')).toEqual({ total: 21, fraction: 15 });
  });

  it('counts a huge exponent without expanding it', () => {
    expect(countDecimalDigits('1e999999')).toEqual({ total: 1000000, fraction: 0 });
  });

  it('counts a number from its exponential String() form like its fixed-point spelling', () => {
    expect(countDecimalDigits(String(1e-7))).toEqual(countDecimalDigits('0.0000001'));
    expect(countDecimalDigits(String(1.5e21))).toEqual(countDecimalDigits('1500000000000000000000'));
  });
});

describe('getConstraintMismatchReason — the reason path counts exponents too (#5186)', () => {
  it('names the facet an exponential value really violates', () => {
    // 1.25e-1 = 0.125: fraction 3 > 1.
    expect(getConstraintMismatchReason({ type: 'bounds', fractionDigits: 1 }, '1.25e-1')).toContain(
      'must have at most 1 fraction digits'
    );
    // 1.5e-1 = 0.15 has 2 total digits. It fails maxInclusive, and the
    // reason must not also blame totalDigits (it used to count "15e-1").
    const reason = getConstraintMismatchReason(
      { type: 'bounds', totalDigits: 2, maxInclusive: 0.1 },
      '1.5e-1'
    );
    expect(reason).toContain('must be <= 0.1');
    expect(reason).not.toContain('total digits');
  });
});
