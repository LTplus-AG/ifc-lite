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

/**
 * A "clean" numeric literal: optional sign, digits, optional decimal,
 * optional scientific exponent. Anchored end-to-end so trailing garbage
 * (`'2022-01-01'`) doesn't smuggle through.
 */
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

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
 * `NUMERIC_RE.test(...)` on both sides keeps date-like strings opaque.
 */
export function compareNumeric(
  expected: string,
  actual: string | number | boolean
): boolean | undefined {
  const actualStr = String(actual);
  const expectedIsNumeric = NUMERIC_RE.test(expected);
  const actualIsNumeric =
    typeof actual === 'number' || NUMERIC_RE.test(actualStr);
  if (!expectedIsNumeric || !actualIsNumeric) return undefined;

  const expectedNum = parseFloat(expected);
  const actualNum = typeof actual === 'number' ? actual : parseFloat(actualStr);
  if (Number.isNaN(expectedNum) || Number.isNaN(actualNum)) return undefined;

  return Math.abs(expectedNum - actualNum) <= numericEpsilon(expectedNum, actualNum);
}

/**
 * Compare an IDS boolean literal to a stored value. Per IDS 1.0 spec
 * the literal MUST be lowercase `true` / `false`; uppercase or
 * numeric forms (`1` / `0`) are malformed and never match.
 *
 * Returns:
 *   - `true` / `false` when both sides resolve to a boolean, OR
 *   - `undefined` when neither side is a recognised boolean — caller
 *     should fall through to other comparators.
 */
export function compareBoolean(
  expected: string,
  actual: string | number | boolean
): boolean | undefined {
  if (expected !== 'true' && expected !== 'false') {
    // Expected isn't a valid boolean literal — caller falls through.
    return undefined;
  }

  if (typeof actual === 'boolean') {
    return expected === 'true' ? actual === true : actual === false;
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
