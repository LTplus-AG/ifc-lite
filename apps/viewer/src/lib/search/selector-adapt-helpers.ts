/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small pure pieces shared by every `adapt*` function in `selector-to-rules.ts`
 * — operator tables, the string/regex/name-kind discriminators, and the
 * quantity-set sniff. Split out to stay under the module size cap; nothing
 * here reads a `FilterRule` or touches the AST beyond the small value/text
 * shapes `@ifc-lite/query` exports, which is what keeps these testable and
 * reusable across the `adapt*` functions without circular imports.
 */

import type { SelectorOp, SelectorText, SelectorValue } from '@ifc-lite/query';
import type { NumericOp, SetOp, TextKind, ValueOp } from './filter-rules.js';

/**
 * The comparison ops every string-ish dimension shares — Name, material and
 * classification alike. Deliberately narrower than `StringOp`: it omits
 * `startsWith`, which the grammar has no spelling for, and it is assignable to
 * `ClassificationOp` as well, so nothing here needs a cast.
 */
export type SharedStringOp = 'eq' | 'ne' | 'contains' | 'notContains' | 'matches' | 'notMatches';

/** `= != > >= < <= *= !*=` onto the property `ValueOp` set. */
export const VALUE_OPS: Partial<Record<SelectorOp, ValueOp>> = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  '*=': 'contains', '!*=': 'notContains',
};

/** The subset that survives onto a string-only dimension (Name, material). */
export const STRING_OPS: Partial<Record<SelectorOp, SharedStringOp>> = {
  '=': 'eq', '!=': 'ne', '*=': 'contains', '!*=': 'notContains',
};

export const NUMERIC_OPS: Partial<Record<SelectorOp, NumericOp>> = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
};

/** The two attributes with a rule behind them; `isPlainTextTerm` reads it too. */
export const FILTERABLE_ATTRIBUTES = new Set(['name', 'predefinedtype']);

/** A regex value only has a meaning for equality and its negation. */
export const REGEX_OPS: Partial<Record<SelectorOp, 'matches' | 'notMatches'>> = {
  '=': 'matches', '!=': 'notMatches',
};

export function setOpFor(op: SelectorOp): SetOp | undefined {
  if (op === '=') return 'in';
  if (op === '!=') return 'notIn';
  return undefined;
}

export function stringOpFor(op: SelectorOp, value: SelectorValue): SharedStringOp | undefined {
  return value.kind === 'regex' ? REGEX_OPS[op] : STRING_OPS[op];
}

/** The bare text of a name or operand: a regex travels as its own source. */
export function literalOf(value: SelectorText): string {
  return value.kind === 'regex' ? value.source : value.text;
}

/**
 * A property-set or property NAME's kind, handed to the rule instead of being
 * re-encoded into a spelling the matcher has to guess back out. A name has no
 * operator beside it, so BOTH kinds have to be stated.
 *
 * Re-encoding was the #4091 defect class at this seam. A quoted name is the
 * grammar's only way to ask for a LITERAL, so `"/Wall/".FireRating` written
 * back as `/Wall/` became a pattern matching `Pset_WallCommon`; and a regex
 * source can itself start and end with a slash, so `Name=/\/tmp\//` written
 * back bare became the pattern `tmp`. Both matched the wrong elements and
 * said nothing.
 */
export function nameKind(name: SelectorText): TextKind {
  return name.kind === 'regex' ? 'regex' : 'literal';
}

/**
 * The same discriminator for a comparison OPERAND, where only one half needs
 * saying: a value reaches a regex op only by having been written as `/…/`, so
 * a rule with no `valueKind` is one whose op already rules a pattern out.
 */
export function regexValueKind(value: SelectorText): TextKind | undefined {
  return value.kind === 'regex' ? 'regex' : undefined;
}

/**
 * A `/…/` that JavaScript cannot compile, reported here rather than at match
 * time. `stringOpMatches` treats an uncompilable pattern as "matches nothing",
 * which is indistinguishable from a correct pattern with no hits — the shape
 * this whole change exists to remove.
 */
export function regexProblem(value: SelectorText | SelectorValue): string | undefined {
  if (value.kind !== 'regex') return undefined;
  try {
    new RegExp(value.source);
    return undefined;
  } catch (err) {
    return `/${value.source}/ is not a valid regular expression: ${(err as Error).message}`;
  }
}

/**
 * A set the quantity rule owns: `Qto_WallBaseQuantities`, or a regex over it.
 * Case-SENSITIVE, like the six other `Qto_` prefix tests in this repo (SDK,
 * lists, ids, ifcx): `Qto_` is a buildingSMART prefix with a fixed spelling, and
 * a selector answering differently for the same set name would be a surface
 * disagreeing with itself. Sets carrying quantities under another name are out
 * of reach; see the guide.
 */
export function looksLikeQuantitySet(pset: SelectorText): boolean {
  if (pset.kind !== 'regex') return pset.text.startsWith('Qto_');
  // A PATTERN names them when `Qto_` opens it or opens one of its alternatives
  // (`/(Qto_Wall|Qto_Slab)…/`); one continuing a word (`/Pset_Qto.*/`) does not.
  return /(?:^|[^A-Za-z0-9_])Qto_/.test(pset.source);
}

export function quantityNeedsNumber(text: string): string {
  return `${quote(text)}: a Qto_ set is read from the quantity table, so it takes a numeric comparison against a number — not NULL, not "*=", not text`;
}

export function unsupportedOp(text: string, op: SelectorOp, value: SelectorValue): string {
  const shape = value.kind === 'regex' ? 'a regular expression' : 'this value';
  return `${quote(text)}: "${op}" is not supported against ${shape} here`;
}

export function quote(text: string): string {
  return JSON.stringify(text);
}
