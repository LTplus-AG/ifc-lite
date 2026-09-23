/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `xs:totalDigits` / `xs:fractionDigits` facet evaluation.
 *
 * Split out of `match-family.ts` (module-size budget) — used by both
 * `matchBounds` there and `getBoundsMismatchReason` in `describe.ts`.
 */

import type { IDSBoundsConstraint } from '../types.js';
import { isStrictNumericLiteral } from './comparators.js';

/**
 * Count decimal digits per XSD §4.3.11/§4.3.12 facet semantics, over any
 * strict numeric literal (`isStrictNumericLiteral`), exponent included.
 * Write the value as `0.D × 10^p`, where `D` has no leading or trailing
 * zeros and `L` digits:
 *
 *  - `fractionDigits` is `n` in value = i × 10⁻ⁿ: the digits after the
 *    decimal point, `max(0, L - p)`. Leading fraction zeros count
 *    (`0.0025` → 4); trailing zeros do not (`1.4500` → 2).
 *  - `totalDigits` is the digit count of `i`. Leading zeros are absorbed
 *    into the scale and never count (`0.0025 = 25 × 10⁻⁴` → 2), trailing
 *    fraction zeros are dropped, and trailing INTEGER zeros stay
 *    significant (`1000` → 4): `max(L, p)`.
 *
 * The exponent is applied arithmetically on the lexical digits (#5186), so
 * `"1.5e3"` counts as 1500 (4, 0) without going through a double or
 * materialising the expanded string. The count is exact for any number of
 * significant digits and any exponent (BigInt), and a literal like
 * `"1e999999"` costs nothing. A `number` is counted from
 * `String(num)`, which may itself be exponential (`1e-7`).
 */
export function countDecimalDigits(literal: string): {
  total: number;
  fraction: number;
} {
  const [mantissaRaw, expRaw] = literal.split(/[eE]/);
  const mantissa = mantissaRaw.replace(/^[+-]/, '');
  // BigInt: an exponent past 2^53 would otherwise round (review on #5280).
  const exp = expRaw === undefined ? 0n : BigInt(expRaw);
  const [intPart, fracPart = ''] = mantissa.split('.');
  const digits = intPart + fracPart;

  const lead = digits.length - digits.replace(/^0+/, '').length;
  const significant = digits.slice(lead).replace(/0+$/, '');
  // Zero in any spelling (`0`, `0.000`, `0e5`): one digit, no fraction.
  if (significant.length === 0) return { total: 1, fraction: 0 };

  const L = BigInt(significant.length);
  const p = BigInt(intPart.length - lead) + exp;
  return {
    total: toCount(L > p ? L : p),
    fraction: toCount(L - p > 0n ? L - p : 0n),
  };
}

/** A count past `Number.MAX_SAFE_INTEGER` cannot be compared exactly with a
 *  facet value (itself a JS number), and exceeds any facet a document can
 *  state exactly, so it reads as `Infinity`: over every bound. */
function toCount(n: bigint): number {
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(n);
}

/**
 * Whether `actualValue` satisfies a bounds constraint's
 * totalDigits/fractionDigits facets. Exported so `describe.ts` can
 * report which one actually rejected the value; `undefined` when
 * neither facet is present (nothing to check) or the value isn't a
 * valid decimal literal.
 */
export function matchDigitFacets(
  constraint: Pick<IDSBoundsConstraint, 'totalDigits' | 'fractionDigits'>,
  actualValue: string | number | boolean
): boolean | undefined {
  if (constraint.totalDigits === undefined && constraint.fractionDigits === undefined) {
    return undefined;
  }
  const decimalStr = String(actualValue);
  // The digit facets are only meaningful against a decimal lexical
  // form; a non-numeric string actual can never satisfy them.
  if (!isStrictNumericLiteral(decimalStr)) return false;
  const { total, fraction } = countDecimalDigits(decimalStr);
  if (constraint.totalDigits !== undefined && total > constraint.totalDigits) {
    return false;
  }
  if (constraint.fractionDigits !== undefined && fraction > constraint.fractionDigits) {
    return false;
  }
  return true;
}
