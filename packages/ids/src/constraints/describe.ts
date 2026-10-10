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
} from './digit-facets.js';
import { isStrictNumericLiteral } from './comparators.js';
import { numericValueOf } from './match-bounds.js';
import { compareOrdered, isOrderedValue } from './xsd-order.js';

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

/**
 * Render the `xs:facet="rawValue"` list for a bounds constraint's
 * `unparseableFacets`, shared by the mismatch-reason and
 * expected-value renderers so both name the same broken facet(s).
 */
function formatUnparseableFacets(
  unparseableFacets: NonNullable<IDSBoundsConstraint['unparseableFacets']>
): string {
  return unparseableFacets.map((f) => `xs:${f.facet}="${f.rawValue}"`).join(', ');
}

function getBoundsMismatchReason(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): string {
  if (constraint.unparseableFacets !== undefined && constraint.unparseableFacets.length > 0) {
    const facets = formatUnparseableFacets(constraint.unparseableFacets);
    return (
      `this xs:restriction is malformed and cannot be evaluated: ` +
      `${facets} ${notReadableAs(constraint)} — fix the IDS specification ` +
      `(every value is being rejected until it is corrected, not just "${actualValue}")`
    );
  }

  if (constraint.temporalBounds !== undefined) {
    return getTemporalBoundsMismatchReason(constraint, actualValue);
  }

  const num = numericValueOf(actualValue);

  if (num === undefined) {
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
    const decimalStr = String(actualValue);
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
 * Why malformed facets could not be read: a min/max bound against the
 * restriction base it failed (#7399), a length or digit count as a
 * non-negative integer.
 */
function notReadableAs(constraint: IDSBoundsConstraint): string {
  const facets = constraint.unparseableFacets ?? [];
  if (!facets.every((f) => /^(min|max)(In|Ex)clusive$/.test(f.facet))) {
    return 'could not be read (a bound must be a value of the restriction base, a length or digit count a non-negative integer)';
  }
  return constraint.base
    ? `is not a valid ${constraint.base} value`
    : 'did not parse as a number';
}

function getTemporalBoundsMismatchReason(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): string {
  const t = constraint.temporalBounds ?? {};
  if (typeof actualValue !== 'string' || !isOrderedValue(actualValue, constraint.base)) {
    return `"${actualValue}" is not a valid ${constraint.base ?? 'date, time or duration'} value`;
  }
  const violations: string[] = [];
  const check = (bound: string | undefined, op: string, ok: (c: -1 | 0 | 1) => boolean): void => {
    if (bound === undefined) return;
    const c = compareOrdered(actualValue, bound, constraint.base);
    // XSD leaves some pairs unordered — a zone-less time within 14 hours
    // of a zoned bound, `P366D` against `P1Y` — and those are not accepted.
    if (c === undefined) violations.push(`cannot be ordered against ${bound}`);
    else if (!ok(c)) violations.push(`must be ${op} ${bound}`);
  };
  check(t.minInclusive, '>=', (c) => c >= 0);
  check(t.maxInclusive, '<=', (c) => c <= 0);
  check(t.minExclusive, '>', (c) => c > 0);
  check(t.maxExclusive, '<', (c) => c < 0);
  return `${actualValue} ${violations.join(' and ')}`;
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
  // A facet present in the XML that failed to parse leaves every
  // numeric field on the constraint `undefined` (see
  // `parser/parse-restriction.ts`), which would otherwise fall through
  // to the `'any value'` default below — self-contradictory for a
  // restriction that is rejecting everything. Name the broken facet(s)
  // instead so the "expected" text sent to the spec author matches the
  // fail-closed behaviour `matchBounds` actually enforces.
  if (constraint.unparseableFacets !== undefined && constraint.unparseableFacets.length > 0) {
    const facets = formatUnparseableFacets(constraint.unparseableFacets);
    return `a value satisfying the xs:restriction — currently unparseable: ${facets} ${notReadableAs(constraint)}`;
  }

  const parts: string[] = [];
  // Date, time and duration bounds are kept as their lexemes; numeric
  // ones as numbers. A constraint carries one kind or the other.
  const t = constraint.temporalBounds;
  const minInclusive = t?.minInclusive ?? constraint.minInclusive;
  const maxInclusive = t?.maxInclusive ?? constraint.maxInclusive;
  const minExclusive = t?.minExclusive ?? constraint.minExclusive;
  const maxExclusive = t?.maxExclusive ?? constraint.maxExclusive;

  if (minInclusive !== undefined && maxInclusive !== undefined) {
    return `between ${minInclusive} and ${maxInclusive}`;
  }

  if (minInclusive !== undefined) {
    parts.push(`>= ${minInclusive}`);
  }

  if (maxInclusive !== undefined) {
    parts.push(`<= ${maxInclusive}`);
  }

  if (minExclusive !== undefined) {
    parts.push(`> ${minExclusive}`);
  }

  if (maxExclusive !== undefined) {
    parts.push(`< ${maxExclusive}`);
  }

  if (constraint.totalDigits !== undefined) {
    parts.push(`<= ${constraint.totalDigits} total digits`);
  }

  if (constraint.fractionDigits !== undefined) {
    parts.push(`<= ${constraint.fractionDigits} fraction digits`);
  }

  return parts.join(' and ') || 'any value';
}
