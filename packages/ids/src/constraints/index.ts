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
 * Numeric tolerance for floating point comparisons.
 *
 * Mirrors IfcOpenShell `ifctester` reference behaviour: the per-
 * comparison epsilon is `2 * 1e-6 * max(|a|, |b|, 1)`. The factor of 2
 * absorbs symmetric round-off in both operands; the `max(…, 1)` keeps
 * sub-unit comparisons stable. Verified against the
 * `Documentation/ImplementersDocumentation/TestCases/tolerance/` fixtures.
 */
const RELATIVE_TOLERANCE = 1e-6;

function numericEpsilon(a: number, b: number): number {
  return 2 * RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b), 1);
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
      return matchPattern(constraint, actualValue);
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

  // Numeric comparison with tolerance
  const expectedNum = parseFloat(expected);
  const actualNum =
    typeof actualValue === 'number' ? actualValue : parseFloat(actualStr);

  if (!isNaN(expectedNum) && !isNaN(actualNum)) {
    return Math.abs(expectedNum - actualNum) <= numericEpsilon(expectedNum, actualNum);
  }

  // Boolean comparison
  if (typeof actualValue === 'boolean') {
    const expectedLower = expected.toLowerCase();
    if (expectedLower === 'true' || expectedLower === '1') {
      return actualValue === true;
    }
    if (expectedLower === 'false' || expectedLower === '0') {
      return actualValue === false;
    }
  }

  // Boolean string comparison
  const actualLower = actualStr.toLowerCase();
  const expectedLower = expected.toLowerCase();
  if (
    (actualLower === 'true' || actualLower === 'false') &&
    (expectedLower === 'true' || expectedLower === 'false')
  ) {
    return actualLower === expectedLower;
  }

  return false;
}

/**
 * Match against a regex pattern
 * IDS uses XSD regex syntax which is slightly different from JavaScript
 */
function matchPattern(
  constraint: IDSPatternConstraint,
  actualValue: string | number | boolean
): boolean {
  const actualStr = String(actualValue);

  try {
    // Convert XSD regex to JavaScript regex
    const jsPattern = xsdToJsRegex(constraint.pattern);
    // IDS patterns must match the entire string
    // Per XSD/IDS spec, patterns are case-sensitive (no 'i' flag)
    const regex = new RegExp(`^${jsPattern}$`);
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
