/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-facet-family matchers — simple value, pattern, enumeration
 * and bounds — plus their compiled-form caches.
 *
 * Split out of `constraints/index.ts` so that module is the matching
 * entry point and this one holds the primitives, letting the reporting
 * module (`describe.ts`) reach them without an import cycle.
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
  isStrictNumericLiteral,
  isBooleanLiteral,
} from './comparators.js';
import { isNumericXsdBase, isBooleanXsdBase } from './xsd-cast.js';
import { translateXsdRegex } from './xsd-regex.js';
import { matchDigitFacets } from './digit-facets.js';

/** Tolerance for the bounds matcher's exclusive comparators. */
export const NUMERIC_TOLERANCE = 1e-6;

/**
 * The conjunctive facets `parseRestriction` attached to this constraint
 * from the same `<xs:restriction>`, or `undefined` when it declared one
 * facet family (the common case). `simpleValue` never carries any: it
 * does not come from a restriction.
 */
export function conjunctiveFacetsOf(
  constraint: IDSConstraint
): readonly IDSConstraint[] | undefined {
  return constraint.type === 'simpleValue' ? undefined : constraint.and;
}

export function matchOneFamily(
  constraint: IDSConstraint,
  actualValue: string | number | boolean,
  ci: boolean
): boolean {
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
 * Per-constraint comparator applicability. `compareNumeric` runs two
 * regex tests and `compareBoolean` two equality checks per call — and
 * simple-value matching sits inside per-entity × per-specification hot
 * loops (name matching against every pset/property). Whether the IDS
 * literal could EVER match numerically or boolean-ly depends only on
 * the constraint, so decide it once.
 */
const SIMPLE_VALUE_COERCIBLE = new WeakMap<IDSSimpleValue, boolean>();

function isCoercibleSimpleValue(constraint: IDSSimpleValue): boolean {
  let coercible = SIMPLE_VALUE_COERCIBLE.get(constraint);
  if (coercible === undefined) {
    coercible =
      isStrictNumericLiteral(constraint.value) ||
      isBooleanLiteral(constraint.value);
    SIMPLE_VALUE_COERCIBLE.set(constraint, coercible);
  }
  return coercible;
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
  // A non-numeric, non-boolean literal can only match through string
  // equality — skip the comparators that would return undefined anyway.
  if (!isCoercibleSimpleValue(constraint)) return false;
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
  // An XSD `xs:pattern` facet constrains the *lexical* space of its base
  // datatype, so it matches the textual representation of the value — the
  // official IDS reference (ifctester) does `re.fullmatch(pattern,
  // str(value))`. A numeric value therefore satisfies e.g.
  // `<restriction base="xs:decimal"><pattern value="^.*$"/>` ("any
  // decimal value present"), which the previous blanket number/boolean
  // bail-out wrongly failed on every numeric property.
  //
  // But the runtime value must first be type-compatible with the declared
  // base: a number only matches a numeric base and a boolean only a
  // boolean base. A number tested against `base="xs:string"` is a type
  // mismatch — buildingSMART's corpus encodes exactly this as
  // `patterns_always_fail_on_any_number`. (A string actual is already the
  // lexical form, so it is matched directly regardless of base.)
  if (typeof actualValue === 'number') {
    if (!isNumericXsdBase(constraint.base)) return false;
  } else if (typeof actualValue === 'boolean') {
    if (!isBooleanXsdBase(constraint.base)) return false;
  }
  const actualStr = String(actualValue);

  const regex = compilePatternRegex(constraint, caseInsensitive);
  // An un-compilable pattern can't match anything (e.g. an unbalanced
  // `[`); treat it as a non-match rather than throwing.
  return regex ? regex.test(actualStr) : false;
}

/**
 * Compiled-pattern cache. Translating XSD → JS regex and building the
 * `RegExp` on every value check dominated pattern-heavy validation; the
 * compiled form depends only on (constraint, caseInsensitive), and the
 * constraint object is stable per parsed document.
 */
const PATTERN_REGEX_CACHE = new WeakMap<
  IDSPatternConstraint,
  { cs?: RegExp | null; ci?: RegExp | null }
>();

function compilePatternRegex(
  constraint: IDSPatternConstraint,
  caseInsensitive: boolean
): RegExp | null {
  let entry = PATTERN_REGEX_CACHE.get(constraint);
  if (!entry) {
    entry = {};
    PATTERN_REGEX_CACHE.set(constraint, entry);
  }
  const slot = caseInsensitive ? 'ci' : 'cs';
  let regex = entry[slot];
  if (regex === undefined) {
    regex = buildPatternRegex(constraint.pattern, caseInsensitive);
    entry[slot] = regex;
  }
  return regex;
}

function buildPatternRegex(
  xsdPattern: string,
  caseInsensitive: boolean
): RegExp | null {
  // XSD char-class subtraction `[a-z-[aeiou]]` has no JS equivalent;
  // approximate as the positive class (drop the exclusion) so the rest
  // of the pattern still evaluates, matching long-standing behaviour.
  const desubtracted = xsdPattern.replace(
    /\[([^\]]+)-\[[^\]]+\]\]/g,
    '[$1]'
  );
  // Shared XSD → JS translation: `\i`/`\c`/`\d`/`\w` (and their
  // negations) map to Unicode property escapes, and verbatim `\p{…}`
  // classes pass through — both require the `u` flag for full fidelity.
  const { pattern } = translateXsdRegex(desubtracted);
  // IDS patterns must match the entire lexical value. Wrapping in a
  // non-capturing group anchors top-level alternation correctly
  // (`a|b` → `^(?:a|b)$`, not `^a|b$`). Case-insensitive matching is
  // opt-in per the call site (entity / predefined-type names use it;
  // property and attribute values do not).
  const anchored = `^(?:${pattern})$`;
  try {
    return new RegExp(anchored, caseInsensitive ? 'iu' : 'u');
  } catch {
    // Some patterns are valid under JS's lenient (Annex-B) dialect but
    // rejected under `u`. Retry without it so plain patterns keep
    // matching; this loses `\p{…}` fidelity for that one pattern only.
    try {
      return new RegExp(anchored, caseInsensitive ? 'i' : '');
    } catch {
      return null;
    }
  }
}

/**
 * Compiled exact-match sets per enumeration constraint. Real-world IDS
 * code lists carry hundreds of values and are matched against every
 * candidate entity, so the linear comparator walk dominated validation
 * time. Constraint objects are stable per parsed document, making a
 * WeakMap cache safe.
 */
const ENUM_VALUE_SETS = new WeakMap<
  IDSEnumerationConstraint,
  { exact: Set<string>; upper: Set<string>; anyCoercible: boolean }
>();

function getEnumValueSets(constraint: IDSEnumerationConstraint): {
  exact: Set<string>;
  upper: Set<string>;
  anyCoercible: boolean;
} {
  let sets = ENUM_VALUE_SETS.get(constraint);
  if (!sets) {
    const exact = new Set(constraint.values);
    const upper = new Set<string>();
    let anyCoercible = false;
    for (const v of constraint.values) {
      upper.add(v.toUpperCase());
      if (isStrictNumericLiteral(v) || isBooleanLiteral(v)) anyCoercible = true;
    }
    sets = { exact, upper, anyCoercible };
    ENUM_VALUE_SETS.set(constraint, sets);
  }
  return sets;
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
  // O(1) fast path: a set hit is exactly the condition under which
  // `compareString` would have returned true for some value, so this
  // never changes the outcome — misses fall through to the full
  // comparator walk for numeric / boolean semantics.
  const sets = getEnumValueSets(constraint);
  const actualStr = String(actualValue);
  if (sets.exact.has(actualStr)) return true;
  if (caseInsensitive && sets.upper.has(actualStr.toUpperCase())) return true;
  // Pure-string enumerations are fully decided by the set lookups —
  // only numeric/boolean literals can still match in the slow walk.
  if (!sets.anyCoercible) return false;

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
    // constraint also carries min/max/totalDigits/fractionDigits we
    // fall through to the numeric check below (rare in practice).
    if (
      constraint.minInclusive === undefined &&
      constraint.maxInclusive === undefined &&
      constraint.minExclusive === undefined &&
      constraint.maxExclusive === undefined &&
      constraint.totalDigits === undefined &&
      constraint.fractionDigits === undefined
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

  const digitsOk = matchDigitFacets(constraint, actualValue);
  if (digitsOk === false) return false;

  return true;
}
