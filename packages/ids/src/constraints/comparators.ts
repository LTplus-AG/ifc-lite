/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared comparators used by every IDS constraint matcher.
 *
 * These helpers encode IDS 1.0 cast-and-compare semantics in one
 * place so `matchSimpleValue`, `matchEnumeration`, and `matchBounds`
 * agree — the older code had `matchEnumeration` using a looser
 * `parseFloat` path that silently equated date-shaped strings.
 */

import { isWhollyNumeric } from '@ifc-lite/encoding';
import type { IDS11ToleranceRule } from '../preview/types.js';
import { equalsWithIds11Tolerance } from '../preview/tolerance.js';
import { xsdBooleanValue } from './xsd-cast.js';

/**
 * Whether an IDS literal could ever match through `compareNumeric` —
 * i.e. it is a strict numeric literal: optional sign, digits, optional
 * decimal, optional scientific exponent, anchored end-to-end so
 * trailing garbage (`'2022-01-01'`) doesn't smuggle through.
 *
 * Delegates to the shared scan in `@ifc-lite/encoding` rather than
 * keeping a local regex. The regex it replaces —
 * `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` — decides the same
 * language but is QUADRATIC on a failing match, because `\d+\.?\d*`
 * retries at every split of the digit run before the engine gives up
 * (#3113). That is reachable: `compareNumeric` runs the check on the
 * model side, so a property value that is a long digit run followed by
 * one non-numeric character costs the same per entity. The scan is
 * linear, allocates nothing, and one implementation cannot drift from
 * the other.
 *
 * Constraint matchers still call this ONCE per constraint rather than
 * inside per-entity hot loops.
 */
export function isStrictNumericLiteral(value: string): boolean {
  return isWhollyNumeric(value);
}

/** Whether an IDS literal could ever match through `compareBoolean`. */
export function isBooleanLiteral(value: string): boolean {
  return xsdBooleanValue(value) !== undefined;
}

/**
 * Numeric tolerance for floating-point comparisons.
 *
 * Mirrors upstream IfcOpenShell `ifctester`'s `is_x` rules: anchored
 * on the IDS-side cast value with a ULP-scaled fudge to absorb the
 * floating-point noise introduced when each side is decoded from text.
 */
const RELATIVE_TOLERANCE = 1e-6;

export function numericEpsilon(castValue: number, actual?: number): number {
  const relative = RELATIVE_TOLERANCE * (1 + Math.abs(castValue));
  const ulp =
    16 * Number.EPSILON *
    Math.max(
      Math.abs(castValue),
      typeof actual === 'number' ? Math.abs(actual) : 0
    );
  return relative + ulp;
}

/**
 * Compare an IDS literal `expected` (always a string from the XML) to
 * `actual` as numbers. Returns:
 *   - `true` / `false` when both sides parse cleanly as numerics, OR
 *   - `undefined` when either side isn't a strict numeric literal,
 *     in which case the caller should fall back to other comparators
 *     (string equality, regex, etc.).
 *
 * Strictness is the whole point: `parseFloat('2022-01-01')` returns
 * `2022`, which would silently equate dates with their year. Requiring
 * `isWhollyNumeric(...)` on both sides keeps date-like strings opaque.
 */
export function compareNumeric(
  expected: string,
  actual: string | number | boolean,
  /** IDS 1.1 PREVIEW (#418) rule from the constraint; unset is the IDS 1.0 comparison. */
  toleranceRule?: IDS11ToleranceRule
): boolean | undefined {
  const actualStr = String(actual);
  const expectedIsNumeric = isWhollyNumeric(expected);
  const actualIsNumeric =
    typeof actual === 'number' || isWhollyNumeric(actualStr);
  if (!expectedIsNumeric || !actualIsNumeric) return undefined;

  const expectedNum = parseFloat(expected);
  const actualNum = typeof actual === 'number' ? actual : parseFloat(actualStr);
  if (Number.isNaN(expectedNum) || Number.isNaN(actualNum)) return undefined;

  if (toleranceRule === 'ids11-418') return equalsWithIds11Tolerance(expectedNum, actualNum);
  return Math.abs(expectedNum - actualNum) <= numericEpsilon(expectedNum, actualNum);
}

/**
 * Compare an IDS boolean literal to a stored value. The literal is read
 * in the xs:boolean lexical space, `true` / `false` / `1` / `0`
 * (`xsdBooleanValue`); uppercase forms (`TRUE`) are not in it and never
 * match. The numeric forms name a boolean only against a stored boolean:
 * a text value that reads `true` is compared as text, so `1` does not
 * match it (#7543).
 *
 * Returns:
 *   - `true` / `false` when the literal is an xs:boolean, OR
 *   - `undefined` when it is not, so the caller falls through to the
 *     other comparators.
 */
export function compareBoolean(
  expected: string,
  actual: string | number | boolean
): boolean | undefined {
  const expectedValue = xsdBooleanValue(expected);
  if (expectedValue === undefined) {
    // Expected isn't a valid boolean literal — caller falls through.
    return undefined;
  }

  if (typeof actual === 'boolean') {
    return actual === expectedValue;
  }

  if (actual === 'true' || actual === 'false') {
    return actual === expected;
  }

  // Anything else against a boolean literal: malformed.
  return false;
}

/**
 * Plain string equality with optional case-insensitive shortcut.
 * Returns `undefined` when no decision can be made so callers can
 * try the numeric / boolean comparators next.
 */
export function compareString(
  expected: string,
  actual: string | number | boolean,
  caseInsensitive: boolean
): boolean | undefined {
  const actualStr = String(actual);
  if (actualStr === expected) return true;
  if (caseInsensitive && actualStr.toUpperCase() === expected.toUpperCase()) {
    return true;
  }
  return undefined;
}
