/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human-readable rendering of an IDS constraint: the expected-value
 * display and the mismatch reason embedded in validation results.
 *
 * Split out of `constraints/index.ts`, which re-exports both entry
 * points, so matching and reporting can grow independently.
 */

import type {
  IDSConstraint,
  IDSBoundsConstraint,
} from '../types.js';
import {
  conjunctiveFacetsOf,
  matchOneFamily,
  NUMERIC_TOLERANCE,
} from './match-family.js';
import {
  matchDigitFacets,
  countDecimalDigits,
  toFixedDecimalString,
} from './digit-facets.js';
import { isStrictNumericLiteral } from './comparators.js';

/**
 * Cap enumeration rendering. These strings are embedded in per-entity
 * validation results — an uncapped 800-value code list produced ~20KB
 * per result and ballooned reports into the gigabytes (OOM crash on
 * large models). The full value list stays available on the constraint
 * object itself.
 */
const MAX_ENUM_DISPLAY_VALUES = 10;

function formatEnumValues(values: string[]): string {
  const shown = values
    .slice(0, MAX_ENUM_DISPLAY_VALUES)
    .map((v) => `"${v}"`)
    .join(', ');
  const more = values.length - MAX_ENUM_DISPLAY_VALUES;
  return more > 0 ? `[${shown}, … +${more} more]` : `[${shown}]`;
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

  // Report the facet that actually rejected the value, not the primary
  // one. With conjunctive facets the primary often matched and a
  // sibling is what failed.
  const siblings = conjunctiveFacetsOf(constraint);
  if (siblings !== undefined && matchOneFamily(constraint, actualValue, false)) {
    for (const sibling of siblings) {
      if (!matchOneFamily(sibling, actualValue, false)) {
        return getConstraintMismatchReason(sibling, actualValue);
      }
    }
  }

  switch (constraint.type) {
    case 'simpleValue':
      return `expected "${constraint.value}", got "${actualValue}"`;
    case 'pattern':
      return `"${actualValue}" does not match pattern "${constraint.pattern}"`;
    case 'enumeration':
      return `"${actualValue}" is not one of ${formatEnumValues(constraint.values)}`;
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

  if (matchDigitFacets(constraint, actualValue) === false) {
    const decimalStr =
      typeof actualValue === 'number'
        ? toFixedDecimalString(actualValue)
        : String(actualValue);
    if (!isStrictNumericLiteral(decimalStr)) {
      violations.push('must be a valid decimal literal');
    } else {
      const { total, fraction } = countDecimalDigits(decimalStr);
      if (constraint.totalDigits !== undefined && total > constraint.totalDigits) {
        violations.push(`must have at most ${constraint.totalDigits} total digits`);
      }
      if (
        constraint.fractionDigits !== undefined &&
        fraction > constraint.fractionDigits
      ) {
        violations.push(
          `must have at most ${constraint.fractionDigits} fraction digits`
        );
      }
    }
  }

  return `${num} ${violations.join(' and ')}`;
}

/**
 * Per-constraint display-string cache. Failure paths format the same
 * constraint for every non-matching entity — millions of times during
 * applicability filtering — and the output depends only on the
 * constraint object.
 */
const FORMAT_CACHE = new WeakMap<IDSConstraint, string>();

/**
 * Format a constraint for display
 */
export function formatConstraint(constraint: IDSConstraint): string {
  let formatted = FORMAT_CACHE.get(constraint);
  if (formatted === undefined) {
    formatted = formatConstraintUncached(constraint);
    FORMAT_CACHE.set(constraint, formatted);
  }
  return formatted;
}

function formatConstraintUncached(constraint: IDSConstraint): string {
  const own = formatOneFamily(constraint);
  const siblings = conjunctiveFacetsOf(constraint);
  if (siblings === undefined) return own;
  // Conjunctive facets from the same restriction. Naming only the
  // primary would report an expectation narrower than the one enforced.
  return [own, ...siblings.map(formatOneFamily)].join(' and ');
}

function formatOneFamily(constraint: IDSConstraint): string {
  switch (constraint.type) {
    case 'simpleValue':
      return `"${constraint.value}"`;
    case 'pattern':
      return `pattern "${constraint.pattern}"`;
    case 'enumeration':
      if (constraint.values.length === 1) {
        return `"${constraint.values[0]}"`;
      }
      return `one of ${formatEnumValues(constraint.values)}`;
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

  if (constraint.totalDigits !== undefined) {
    parts.push(`<= ${constraint.totalDigits} total digits`);
  }

  if (constraint.fractionDigits !== undefined) {
    parts.push(`<= ${constraint.fractionDigits} fraction digits`);
  }

  return parts.join(' and ') || 'any value';
}
