/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bounds-family matcher: min/max bounds, string lengths and digit
 * counts. Split out of `match-family.ts` (module-size budget) when bounds
 * learned to compare by their restriction's `@base` (#7399).
 */

import type { IDSBoundsConstraint } from '../types.js';
import { matchDigitFacets } from './digit-facets.js';
import { compareOrdered, readNumeric } from './xsd-order.js';

/**
 * The value a numeric bound compares against: a number as given, or a
 * string whose WHOLE text is a numeric lexeme. `parseFloat` used to read
 * `"2024-12-31"` as 2024 and `"5 m"` as 5, so a non-number satisfied a
 * numeric range by its prefix (#7399).
 */
export function numericValueOf(actualValue: string | number | boolean): number | undefined {
  if (typeof actualValue === 'number') return Number.isNaN(actualValue) ? undefined : actualValue;
  if (typeof actualValue !== 'string') return undefined;
  return readNumeric(actualValue, 'xs:double');
}

/**
 * Whether `actualValue` satisfies the `temporalBounds` of an `xs:date` /
 * `xs:dateTime` / `xs:time` / `xs:duration` restriction. A value outside
 * the base's value space, or one XSD leaves unordered against a bound,
 * fails.
 */
export function matchTemporalBounds(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): boolean {
  const t = constraint.temporalBounds;
  if (t === undefined) return true;
  const cmp = (bound: string): -1 | 0 | 1 | undefined =>
    compareOrdered(actualValue, bound, constraint.base);
  const holds = (bound: string | undefined, ok: (c: -1 | 0 | 1) => boolean): boolean => {
    if (bound === undefined) return true;
    const c = cmp(bound);
    return c !== undefined && ok(c);
  };
  return (
    holds(t.minInclusive, (c) => c >= 0) &&
    holds(t.maxInclusive, (c) => c <= 0) &&
    holds(t.minExclusive, (c) => c > 0) &&
    holds(t.maxExclusive, (c) => c < 0)
  );
}

/**
 * Match against bounds.
 */
export function matchBounds(
  constraint: IDSBoundsConstraint,
  actualValue: string | number | boolean
): boolean {
  // A facet element was present in the source `<xs:restriction>` but
  // its `@value` is not in the lexical space it needs (a typo, a wrong
  // decimal separator, a date under a numeric base, a negative
  // digit-count, …). `parseRestriction` left it unset, the same as a
  // facet that was never present — which would otherwise make this an
  // unconditional pass. Fail closed instead: we cannot verify
  // compliance against a restriction we could not fully parse, so no
  // value passes until the IDS is corrected. See
  // `getBoundsMismatchReason` for the author-facing explanation and
  // `audit/coherence` for the corresponding lint diagnostic.
  if (constraint.unparseableFacets !== undefined && constraint.unparseableFacets.length > 0) {
    return false;
  }

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
    // constraint also carries min/max/totalDigits/fractionDigits we
    // fall through to the numeric check below (rare in practice).
    if (
      constraint.minInclusive === undefined &&
      constraint.maxInclusive === undefined &&
      constraint.minExclusive === undefined &&
      constraint.maxExclusive === undefined &&
      constraint.temporalBounds === undefined &&
      constraint.totalDigits === undefined &&
      constraint.fractionDigits === undefined
    ) {
      return true;
    }
  }

  // Date, time and duration bounds order in their own value space, and a
  // number never satisfies them.
  if (constraint.temporalBounds !== undefined) {
    return matchTemporalBounds(constraint, actualValue);
  }

  const num = numericValueOf(actualValue);
  if (num === undefined) return false;

  if (constraint.minInclusive !== undefined && num < constraint.minInclusive) {
    return false;
  }

  if (constraint.maxInclusive !== undefined && num > constraint.maxInclusive) {
    return false;
  }

  if (constraint.minExclusive !== undefined && num <= constraint.minExclusive) {
    return false;
  }

  if (constraint.maxExclusive !== undefined && num >= constraint.maxExclusive) {
    return false;
  }

  const digitsOk = matchDigitFacets(constraint, actualValue);
  if (digitsOk === false) return false;

  return true;
}
