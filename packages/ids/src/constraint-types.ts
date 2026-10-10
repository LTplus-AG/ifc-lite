/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS constraint types — the value-matching half of the IDS type model.
 *
 * Split out of `types.ts`, which re-exports every name here, so the two
 * can grow independently. Import from `../types.js` (or the package
 * root) as before; this module is an implementation detail of that
 * re-export.
 */

/** Union of all constraint types */
export type IDSConstraint =
  | IDSSimpleValue
  | IDSPatternConstraint
  | IDSEnumerationConstraint
  | IDSBoundsConstraint;

/** Simple value - exact match */
export interface IDSSimpleValue {
  type: 'simpleValue';
  /** The exact value to match */
  value: string;
}

/** Pattern constraint - regex match */
export interface IDSPatternConstraint {
  type: 'pattern';
  /** XSD regex pattern */
  pattern: string;
  /**
   * The originating `xs:restriction @base` (e.g. `xs:string`, `xs:integer`).
   * Set when the constraint came from an `<xs:restriction>` element; the
   * auditor uses it to determine compatibility with an IFC dataType
   * without inferring the base from the constraint shape.
   */
  base?: string;
  /**
   * Facets of the SAME `<xs:restriction>` beyond this one. XSD facets in
   * a single restriction are conjunctive — a value must satisfy every
   * one — but one `IDSConstraint` expresses only one family, so
   * `parseRestriction` keeps the first here and hangs the rest off this
   * list for `matchConstraint` to require as well. Unset for the
   * overwhelmingly common single-family restriction. Matching
   * (`matchConstraint`) and the two description paths
   * (`formatConstraint`, `TranslationService.describeConstraint`)
   * account for it. The IDS-document auditors under `audit/` still
   * inspect only the primary family, so a malformed regex or an
   * inverted bound in a sibling is not linted.
   */
  and?: readonly IDSConstraint[];
}

/** Enumeration constraint - one of a list of values */
export interface IDSEnumerationConstraint {
  type: 'enumeration';
  /** List of allowed values */
  values: string[];
  /**
   * The originating `xs:restriction @base` (e.g. `xs:string`,
   * `xs:integer`). Set when the constraint came from an
   * `<xs:restriction>`; numeric/boolean enumerations carry their base
   * here so the auditor doesn't false-positive a string-base mismatch.
   */
  base?: string;
  /**
   * Facets of the SAME `<xs:restriction>` beyond this one. XSD facets in
   * a single restriction are conjunctive — a value must satisfy every
   * one — but one `IDSConstraint` expresses only one family, so
   * `parseRestriction` keeps the first here and hangs the rest off this
   * list for `matchConstraint` to require as well. Unset for the
   * overwhelmingly common single-family restriction. Matching
   * (`matchConstraint`) and the two description paths
   * (`formatConstraint`, `TranslationService.describeConstraint`)
   * account for it. The IDS-document auditors under `audit/` still
   * inspect only the primary family, so a malformed regex or an
   * inverted bound in a sibling is not linted.
   */
  and?: readonly IDSConstraint[];
}

/** Bounds constraint - numeric range or string length */
export interface IDSBoundsConstraint {
  type: 'bounds';
  /** Minimum inclusive value */
  minInclusive?: number;
  /** Maximum inclusive value */
  maxInclusive?: number;
  /** Minimum exclusive value */
  minExclusive?: number;
  /** Maximum exclusive value */
  maxExclusive?: number;
  /** xs:length — exact string length */
  length?: number;
  /** xs:minLength — minimum string length */
  minLength?: number;
  /** xs:maxLength — maximum string length */
  maxLength?: number;
  /** xs:totalDigits — maximum number of significant decimal digits */
  totalDigits?: number;
  /** xs:fractionDigits — maximum number of digits after the decimal point */
  fractionDigits?: number;
  /**
   * The originating `xs:restriction @base` (e.g. `xs:double`,
   * `xs:integer`). Set when the constraint came from an
   * `<xs:restriction>` so the auditor can compare against the IFC
   * dataType's backing type directly.
   */
  base?: string;
  /**
   * Facets of the SAME `<xs:restriction>` beyond this one. XSD facets in
   * a single restriction are conjunctive — a value must satisfy every
   * one — but one `IDSConstraint` expresses only one family, so
   * `parseRestriction` keeps the first here and hangs the rest off this
   * list for `matchConstraint` to require as well. Unset for the
   * overwhelmingly common single-family restriction. Matching
   * (`matchConstraint`) and the two description paths
   * (`formatConstraint`, `TranslationService.describeConstraint`)
   * account for it. The IDS-document auditors under `audit/` still
   * inspect only the primary family, so a malformed regex or an
   * inverted bound in a sibling is not linted.
   */
  and?: readonly IDSConstraint[];
  /**
   * The bound facets of an `xs:date` / `xs:dateTime` / `xs:time` /
   * `xs:duration` restriction, as their validated lexical text. Those
   * value spaces are not numbers, so the numeric `min*` / `max*` fields
   * above stay unset for them and the bounds live here instead, compared
   * in the base's own order (#7399).
   */
  temporalBounds?: {
    minInclusive?: string;
    maxInclusive?: string;
    minExclusive?: string;
    maxExclusive?: string;
  };
  /**
   * Facets whose `<xs:*Inclusive|Exclusive|Length|Digits>` element was
   * PRESENT in the source `<xs:restriction>` but whose `@value` is not in
   * the lexical space the facet requires: for a min/max bound, the
   * restriction `@base`'s (#7399); for a length or digit-count facet, a
   * non-negative integer — e.g. a typo'd `"6O"` (letter O), the European
   * decimal `"6,5"`, or `"2024-13-01"` under `xs:date`. Distinct from a facet that was
   * never present at all: the corresponding numeric field above is
   * `undefined` in BOTH cases, but only this list distinguishes "no
   * such constraint" from "the author tried to constrain this and
   * failed." `matchBounds` fails closed (rejects every value) when this
   * is non-empty, rather than silently treating a botched restriction
   * as unbounded.
   */
  unparseableFacets?: readonly { readonly facet: string; readonly rawValue: string }[];
}
