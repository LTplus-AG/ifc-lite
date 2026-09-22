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
 * Canonical fixed-point decimal string for a JS number (no scientific
 * notation) — `xs:totalDigits`/`xs:fractionDigits` are defined over the
 * lexical decimal form, and `String(1e-7)` would otherwise smuggle an
 * `e` into the digit count.
 */
export function toFixedDecimalString(num: number): string {
  const str = String(num);
  if (!/e/i.test(str)) return str;
  const [mantissa, expStr] = str.split(/e/i);
  const exp = parseInt(expStr, 10);
  const neg = mantissa.startsWith('-');
  const m = neg ? mantissa.slice(1) : mantissa;
  const [intPart, fracPart = ''] = m.split('.');
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = `${digits}${'0'.repeat(pointPos - digits.length)}`;
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  return neg ? `-${out}` : out;
}

/**
 * Count decimal digits per XSD §4.3.11/§4.3.12 facet semantics. The two
 * facets treat leading fraction zeros DIFFERENTLY:
 *
 *  - `fractionDigits` is `n` in value = i × 10⁻ⁿ: the count of digits
 *    after the decimal point, full stop. Leading zeros in the fraction
 *    DO count (`0.0025` → 4) since they fix the magnitude (`10⁻ⁿ`);
 *    only trailing zeros are insignificant (`1.4500` → 2).
 *  - `totalDigits` is the digit count of `i` in that same value = i ×
 *    10⁻ⁿ. Leading zeros — in the integer part AND in the fraction
 *    before the first non-zero digit — are absorbed into the `10⁻ⁿ`
 *    scale factor and do NOT count (`0.0025 = 25 × 10⁻⁴` → 2, not 4).
 *    Trailing zeros in the fraction are still dropped (`0.250` → `25`
 *    → 2). Trailing zeros in the INTEGER part stay significant per the
 *    digit-count reading (`1000` → 4): only leading zeros are stripped.
 */
export function countDecimalDigits(decimalStr: string): {
  total: number;
  fraction: number;
} {
  const unsigned = decimalStr.replace(/^[+-]/, '');
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const fracTrimmed = fracPartRaw.replace(/0+$/, '');
  const fraction = fracTrimmed.length;

  // totalDigits: strip every leading zero — integer-part zeros AND any
  // fraction zeros before the first significant digit — then count
  // what's left of the (trailing-trimmed) digit string.
  const totalTrimmed = (intPartRaw + fracTrimmed).replace(/^0+/, '');
  const total = totalTrimmed.length === 0 ? 1 : totalTrimmed.length;

  return { total, fraction };
}

/**
 * Normalise a string `actualValue` the same way the `number` branch
 * already is, but only when it actually needs it. A string already in
 * fixed-point form (`"0012.3400"`) is left untouched — routing it
 * through `parseFloat`/`toFixedDecimalString` would be a no-op for the
 * digit count (both zero-strip identically) but would gratuitously cap
 * it at IEEE-754 double precision for arbitrary-precision XSD
 * `decimal` literals. Only an exponential string, which
 * `countDecimalDigits` cannot read directly (the `e`/`E` would be
 * counted as a digit), is parsed and re-rendered fixed-point.
 *
 * That parse goes through a JS double, so it is exact for the range
 * that already governs the `number` branch (IEEE-754, ~15–17
 * significant decimal digits) and lossy beyond it — a large
 * exponential literal past that ceiling trades an `e`-as-digit
 * miscount for a rounded one, not for an exact count. It does not
 * introduce trailing-garbage risk (#5193's parser-side failure mode):
 * the string is admitted by `isStrictNumericLiteral` first, which
 * anchors end-to-end, so `parseFloat` never sees or silently drops
 * trailing non-numeric characters.
 */
function normalizeStringLiteral(raw: string): string {
  if (!/e/i.test(raw) || !isStrictNumericLiteral(raw)) return raw;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? toFixedDecimalString(parsed) : raw;
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
  const decimalStr =
    typeof actualValue === 'number'
      ? toFixedDecimalString(actualValue)
      : normalizeStringLiteral(String(actualValue));
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
