/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ── Operator enums ────────────────────────────────────────────────────────────
/** Set-membership: storey, ifcType, predefinedType. */
export type SetOp = 'in' | 'notIn';

/** String comparisons (Name rule). */
export type StringOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'matches'
  | 'notMatches';

/** Numeric comparisons (Quantity rule). */
export type NumericOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** Mixed string+numeric+presence ops for Property values. */
export type ValueOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'notMatches'
  | 'isSet'
  | 'isNotSet'
  | 'isNonEmpty'
  | 'isNull'
  | 'isNotNull';

/** Comparison details needed when a saved Lens, List or Bulk condition is
 * converted to the common rule vocabulary (#5892). Defaults keep existing
 * search/validation behavior. */
export interface ValueComparison {
  /** Search folds case; saved Lens/List equality keeps significant case except IFC booleans. */
  caseMode?: 'fold' | 'exact' | 'lensBoolean' | 'ifcBoolean';
  /** Lists use Number(), while search and Lens use parseFloat() for numeric comparisons. */
  numericMode?: 'prefix' | 'strict';
  /** Bulk uses typed operands (including its boolean-string coercion) rather than search's stringification. */
  typeMode?: 'bulk';
  operandType?: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'array';
}

/** Classification value+presence ops. A classification is matched against
 *  its code / name string, so this is the StringOp comparison subset plus
 *  presence — numeric ops don't apply. */
export type ClassificationOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'notMatches'
  | 'isSet'
  | 'isNotSet';

/** Top-level rule combinator. */
export type Combinator = 'AND' | 'OR';

/**
 * How a rule reads one of its strings — the producer saying so, because the
 * string itself cannot.
 *
 * `'regex'` is a regular-expression SOURCE: the WHOLE string is the pattern,
 * slashes included. `'literal'` is exact text that is never a pattern, however
 * it happens to be spelled. Absent means free text a human typed into a chip
 * field, which keeps the Lists-panel convention (#1591): a `/body/flags`
 * literal is a pattern, anything else is plain text.
 *
 * Guessing this back out of the text is the #4091 defect class — matched the
 * wrong thing, said nothing — reappearing at the adapter seam. The selector
 * grammar knows which it parsed: quoting is its ONLY escape hatch for a
 * literal name, so `"/Wall/".FireRating` is the plain name `/Wall/`, and
 * `Name=/\/tmp\//` is the source `/tmp/`. Sniffed for slashes, the first
 * matches every `…Wall…` set and the second matches `tmp`.
 *
 * A property-set or property NAME has no operator beside it, so both kinds
 * have to be declared. A VALUE's op already says whether it is a pattern, so
 * only `'regex'` is ever recorded there.
 */
export type TextKind = 'literal' | 'regex';
