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

import {
  compareBoolean,
  compareNumeric,
  compareString,
  numericEpsilon,
} from './comparators.js';

/** Tolerance for the bounds matcher's exclusive comparators. */
const NUMERIC_TOLERANCE = 1e-6;

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
 * Match against a simple value. Tries each comparator in order:
 * string → numeric → boolean. The first decisive result wins;
 * `undefined` lets the next strategy run.
 */
function matchSimpleValue(
  constraint: IDSSimpleValue,
  actualValue: string | number | boolean,
  caseInsensitive: boolean
): boolean {
  const expected = constraint.value;
  const stringResult = compareString(expected, actualValue, caseInsensitive);
  if (stringResult !== undefined) return stringResult;
  const numericResult = compareNumeric(expected, actualValue);
  if (numericResult !== undefined) return numericResult;
  const booleanResult = compareBoolean(expected, actualValue);
  if (booleanResult !== undefined) return booleanResult;
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
 * Match against an enumeration. The actual value matches if ANY of the
 * declared options matches under string / numeric / boolean comparison
 * — same strategy table as `matchSimpleValue`, just iterated.
 */
function matchEnumeration(
  constraint: IDSEnumerationConstraint,
  actualValue: string | number | boolean,
  caseInsensitive: boolean
): boolean {
  return constraint.values.some((v) => {
    const stringResult = compareString(v, actualValue, caseInsensitive);
    if (stringResult !== undefined) return stringResult;
    const numericResult = compareNumeric(v, actualValue);
    if (numericResult !== undefined) return numericResult;
    const booleanResult = compareBoolean(v, actualValue);
    if (booleanResult !== undefined) return booleanResult;
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
