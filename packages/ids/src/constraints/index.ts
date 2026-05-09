/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constraint matching utilities for IDS validation
 */

import type {
  IDSConstraint,
  IDSSimpleValue,
  IDSPatternConstraint,
  IDSEnumerationConstraint,
  IDSBoundsConstraint,
} from '../types.js';

/**
 * Numeric tolerance for floating-point comparisons.
 *
 * Mirrors upstream IfcOpenShell `ifctester`'s `is_x` (see
 * `src/ifctester/ifctester/facet.py`): `actual` is considered equal to
 * the expected `cast_value` when it lies within
 * `[cast_value * (1 - 1e-6), cast_value * (1 + 1e-6)]` (asymmetric —
 * the tolerance is relative to the *expected* value, not the larger of
 * the pair). The check is anchored on `cast_value` so callers must
 * pass the IDS-side value as the second argument.
 */
const RELATIVE_TOLERANCE = 1e-6;

function isCloseToCastValue(actual: number, castValue: number): boolean {
  if (castValue >= 0) {
    if (
      actual < castValue * (1 - RELATIVE_TOLERANCE) ||
      actual > castValue * (1 + RELATIVE_TOLERANCE)
    ) {
      return false;
    }
  } else if (
    actual > castValue * (1 - RELATIVE_TOLERANCE) ||
    actual < castValue * (1 + RELATIVE_TOLERANCE)
  ) {
    return false;
  }
  return true;
}

/**
 * Tolerance anchored on the IDS-side cast value (the *expected* value),
 * matching upstream ifctester semantics:
 * `|actual - cast| <= 1e-6 * (1 + |cast|)`.
 * The first argument MUST be the cast value (i.e. the constraint side),
 * not the actual property value — magnitude of the actual is irrelevant
 * to the tolerance window's *width*.
 *
 * A small ULP-scaled fudge (`16 * EPSILON * max(|actual|,|cast|)`) is
 * added to absorb the floating-point noise introduced when each side is
 * decoded from text (`parseFloat`/`IFCREAL`) — without it, boundary
 * fixtures that store decimals like `1000001.000001` would fail equality
 * by ~1e-12 due to IEEE-754 representation, even though both sides
 * agree to the printed precision.
 */
function numericEpsilon(castValue: number, actual?: number): number {
  const relative = RELATIVE_TOLERANCE * (1 + Math.abs(castValue));
  const ulp = 16 * Number.EPSILON * Math.max(
    Math.abs(castValue),
    typeof actual === 'number' ? Math.abs(actual) : 0,
  );
  return relative + ulp;
}

/** Back-compat alias for callers that still expect a single constant. */
const NUMERIC_TOLERANCE = RELATIVE_TOLERANCE;

/** Options for constraint matching */
export interface MatchOptions {
  /**
   * If true, use case-insensitive comparison for string values.
   * Per IDS 1.0 spec, only entity type names and predefined types
   * should be compared case-insensitively. All other values
   * (property values, classification values, etc.) are case-sensitive.
   */
  caseInsensitive?: boolean;
}

/**
 * Check if a value matches a constraint
 */
export function matchConstraint(
  constraint: IDSConstraint,
  actualValue: string | number | boolean | null | undefined,
  options?: MatchOptions
): boolean {
  if (actualValue === null || actualValue === undefined) {
    return false;
  }

  const ci = options?.caseInsensitive ?? false;

  switch (constraint.type) {
    case 'simpleValue':
      return matchSimpleValue(constraint, actualValue, ci);
    case 'pattern':
      return matchPattern(constraint, actualValue, ci);
    case 'enumeration':
      return matchEnumeration(constraint, actualValue, ci);
    case 'bounds':
      return matchBounds(constraint, actualValue);
    default:
      return false;
  }
}

/**
 * Match against a simple value (exact match)
 */
function matchSimpleValue(
  constraint: IDSSimpleValue,
  actualValue: string | number | boolean,
  caseInsensitive: boolean
): boolean {
  const expected = constraint.value;
  const actualStr = String(actualValue);

  // Exact string match
  if (actualStr === expected) return true;

  // Case-insensitive match only when explicitly requested (IFC entity/predefined type names)
  if (caseInsensitive && actualStr.toUpperCase() === expected.toUpperCase()) return true;

  // Numeric comparison with tolerance — only when *both* sides parse
  // cleanly as a single numeric token. `parseFloat` accepts trailing
  // garbage (`'2022-01-01' → 2022`), which would silently equate dates
  // and other date-like strings. Use a strict matcher so e.g.
  // `'2022-01-01+00:00'` and `'2022-01-01'` keep their string identity.
  const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const expectedIsNumeric = NUMERIC_RE.test(expected);
  const actualIsNumeric =
    typeof actualValue === 'number' || NUMERIC_RE.test(actualStr);
  if (expectedIsNumeric && actualIsNumeric) {
    const expectedNum = parseFloat(expected);
    const actualNum =
      typeof actualValue === 'number' ? actualValue : parseFloat(actualStr);
    if (!isNaN(expectedNum) && !isNaN(actualNum)) {
      return Math.abs(expectedNum - actualNum) <= numericEpsilon(expectedNum, actualNum);
    }
  }

  // Boolean comparison — per IDS 1.0 spec the literal MUST be
  // lowercase (`true` / `false`). Uppercase or mixed-case literals
  // are malformed and never match a stored boolean value.
  if (typeof actualValue === 'boolean') {
    if (expected === 'true') return actualValue === true;
    if (expected === 'false') return actualValue === false;
    // Reject any other casing or numeric form for boolean actuals.
    return false;
  }

  // Boolean string comparison (both sides are textual booleans). Same
  // strict-lowercase rule applies.
  if (
    (actualStr === 'true' || actualStr === 'false') &&
    (expected === 'true' || expected === 'false')
  ) {
    return actualStr === expected;
  }

  return false;
}

/**
 * Match against a regex pattern
 * IDS uses XSD regex syntax which is slightly different from JavaScript
 */
function matchPattern(
  constraint: IDSPatternConstraint,
  actualValue: string | number | boolean,
  caseInsensitive = false
): boolean {
  // Per IDS 1.0 spec patterns ONLY apply to string values. A pattern
  // tested against a number / boolean fails outright — even if the
  // textual representation would happen to match — so the validator
  // can distinguish "wrong shape" from "wrong value".
  if (typeof actualValue === 'number' || typeof actualValue === 'boolean') {
    return false;
  }
  const actualStr = String(actualValue);

  try {
    // Convert XSD regex to JavaScript regex
    const jsPattern = xsdToJsRegex(constraint.pattern);
    // IDS patterns must match the entire string. Case-insensitive
    // matching is opt-in per the call site (entity / predefined-type
    // names use it; property and attribute values do not).
    const flags = caseInsensitive ? 'i' : '';
    const regex = new RegExp(`^${jsPattern}$`, flags);
    return regex.test(actualStr);
  } catch {
    // If pattern is invalid, don't match
    return false;
  }
}

/**
 * Convert XSD regex syntax to JavaScript regex
 */
function xsdToJsRegex(xsdPattern: string): string {
  return (
    xsdPattern
      // XSD \i (initial name char) -> [A-Za-z_:]
      .replace(/\\i/g, '[A-Za-z_:]')
      // XSD \c (name char) -> [A-Za-z0-9._:-]
      .replace(/\\c/g, '[A-Za-z0-9._:-]')
      // XSD \p{...} character classes - simplified handling
      .replace(/\\p\{[^}]+\}/g, '.')
      // XSD subtraction [a-z-[aeiou]] not supported in JS - simplify
      .replace(/\[([^\]]+)-\[[^\]]+\]\]/g, '[$1]')
  );
}

/**
 * Match against an enumeration (one of a list)
 */
function matchEnumeration(
  constraint: IDSEnumerationConstraint,
  actualValue: string | number | boolean,
  caseInsensitive: boolean
): boolean {
  const actualStr = String(actualValue);
  const actualUpper = actualStr.toUpperCase();

  return constraint.values.some((v) => {
    // Try exact match first
    if (v === actualStr) return true;
    // Case-insensitive match only when explicitly requested
    if (caseInsensitive && v.toUpperCase() === actualUpper) return true;
    // Numeric comparison
    const vNum = parseFloat(v);
    const actualNum =
      typeof actualValue === 'number' ? actualValue : parseFloat(actualStr);
    if (!isNaN(vNum) && !isNaN(actualNum)) {
      return Math.abs(vNum - actualNum) <= NUMERIC_TOLERANCE;
    }
    return false;
  });
}

/**
 * Match against numeric bounds
 */
function matchBounds(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): boolean {
  // String-length facets (xs:length / xs:minLength / xs:maxLength)
  // operate on the textual length, not on numeric magnitude. When any
  // of them are present, evaluate the length constraints first.
  if (
    constraint.length !== undefined ||
    constraint.minLength !== undefined ||
    constraint.maxLength !== undefined
  ) {
    const str = String(actualValue);
    if (constraint.length !== undefined && str.length !== constraint.length) {
      return false;
    }
    if (constraint.minLength !== undefined && str.length < constraint.minLength) {
      return false;
    }
    if (constraint.maxLength !== undefined && str.length > constraint.maxLength) {
      return false;
    }
    // Length-only restrictions don't impose numeric bounds; if the
    // constraint also carries min/max we fall through to the numeric
    // check below (rare in practice).
    if (
      constraint.minInclusive === undefined &&
      constraint.maxInclusive === undefined &&
      constraint.minExclusive === undefined &&
      constraint.maxExclusive === undefined
    ) {
      return true;
    }
  }

  const num =
    typeof actualValue === 'number'
      ? actualValue
      : parseFloat(String(actualValue));

  if (isNaN(num)) return false;

  if (
    constraint.minInclusive !== undefined &&
    num < constraint.minInclusive
  ) {
    return false;
  }

  if (
    constraint.maxInclusive !== undefined &&
    num > constraint.maxInclusive
  ) {
    return false;
  }

  if (constraint.minExclusive !== undefined && num <= constraint.minExclusive) {
    return false;
  }

  if (constraint.maxExclusive !== undefined && num >= constraint.maxExclusive) {
    return false;
  }

  return true;
}

/**
 * Get a human-readable description of why a constraint match failed
 */
export function getConstraintMismatchReason(
  constraint: IDSConstraint,
  actualValue: string | number | boolean | null | undefined
): string {
  if (actualValue === null || actualValue === undefined) {
    return 'value is missing';
  }

  switch (constraint.type) {
    case 'simpleValue':
      return `expected "${constraint.value}", got "${actualValue}"`;
    case 'pattern':
      return `"${actualValue}" does not match pattern "${constraint.pattern}"`;
    case 'enumeration':
      return `"${actualValue}" is not one of [${constraint.values.map((v) => `"${v}"`).join(', ')}]`;
    case 'bounds':
      return getBoundsMismatchReason(constraint, actualValue);
    default:
      return 'unknown constraint type';
  }
}

function getBoundsMismatchReason(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): string {
  const num =
    typeof actualValue === 'number'
      ? actualValue
      : parseFloat(String(actualValue));

  if (isNaN(num)) {
    return `"${actualValue}" is not a valid number`;
  }

  const violations: string[] = [];

  if (
    constraint.minInclusive !== undefined &&
    num < constraint.minInclusive - NUMERIC_TOLERANCE
  ) {
    violations.push(`must be >= ${constraint.minInclusive}`);
  }

  if (
    constraint.maxInclusive !== undefined &&
    num > constraint.maxInclusive + NUMERIC_TOLERANCE
  ) {
    violations.push(`must be <= ${constraint.maxInclusive}`);
  }

  if (constraint.minExclusive !== undefined && num <= constraint.minExclusive) {
    violations.push(`must be > ${constraint.minExclusive}`);
  }

  if (constraint.maxExclusive !== undefined && num >= constraint.maxExclusive) {
    violations.push(`must be < ${constraint.maxExclusive}`);
  }

  return `${num} ${violations.join(' and ')}`;
}

/**
 * Format a constraint for display
 */
export function formatConstraint(constraint: IDSConstraint): string {
  switch (constraint.type) {
    case 'simpleValue':
      return `"${constraint.value}"`;
    case 'pattern':
      return `pattern "${constraint.pattern}"`;
    case 'enumeration':
      if (constraint.values.length === 1) {
        return `"${constraint.values[0]}"`;
      }
      return `one of [${constraint.values.map((v) => `"${v}"`).join(', ')}]`;
    case 'bounds':
      return formatBounds(constraint);
    default:
      return 'unknown';
  }
}

function formatBounds(constraint: IDSBoundsConstraint): string {
  const parts: string[] = [];

  if (
    constraint.minInclusive !== undefined &&
    constraint.maxInclusive !== undefined
  ) {
    return `between ${constraint.minInclusive} and ${constraint.maxInclusive}`;
  }

  if (constraint.minInclusive !== undefined) {
    parts.push(`>= ${constraint.minInclusive}`);
  }

  if (constraint.maxInclusive !== undefined) {
    parts.push(`<= ${constraint.maxInclusive}`);
  }

  if (constraint.minExclusive !== undefined) {
    parts.push(`> ${constraint.minExclusive}`);
  }

  if (constraint.maxExclusive !== undefined) {
    parts.push(`< ${constraint.maxExclusive}`);
  }

  return parts.join(' and ') || 'any value';
}
