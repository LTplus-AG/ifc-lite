/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure operator matching for the filter rule taxonomy (ported verbatim from
 * the Tauri-side `filter.rs` engine).
 *
 * Split out of `filter-rules.ts` at the op seam so both stay under the module
 * size cap: that file owns the rule SHAPES, their constructors and the JSON
 * guards, this one owns what an operator MEANS. Nothing here reads a rule —
 * each function takes an operator, a candidate and the rule's operand, which
 * is what makes them testable without a model.
 */

import { compileNameMatcher, isNamePattern } from '@ifc-lite/lists';
import type { NumericOp, SetOp, StringOp, TextKind, ValueOp } from './filter-rules.js';

/**
 * Lower-case a candidate that may be undefined at runtime — crash-safety
 * only (#1195). Does NOT decide what "no value" means to an operator:
 * `undefined` (absent) vs `''` (explicitly empty) is a real distinction a
 * caller must resolve before calling this — see `stringOpMatches` (#4930).
 */
function lower(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

/**
 * Regex matching for the `matches` / `notMatches` ops, shared by every rule
 * kind that owns them.
 *
 * `kind` is the producer speaking (see {@link TextKind}). A declared operand is
 * a regular-expression SOURCE and the WHOLE string is the pattern, slashes
 * included — that is what makes the selector `Name=/\/tmp\//` look for `/tmp/`
 * rather than `tmp`. An operand with no declared kind is free text under the
 * Lists-panel convention (#1591): a `/body/flags` literal is a pattern, flags
 * and all, and anything else is a bare source. That is the spelling the chip
 * editors ask for, and there the slashes ARE the user's only way to say
 * "pattern", so reading them is the grammar rather than a guess.
 *
 * Case-SENSITIVE, unlike every other op here: the selector grammar's `/…/` is
 * a Python regular expression, and those do not fold case. Write JavaScript's
 * equivalent of `(?i)` by adding an `i` flag to a full literal (`/wand/i`).
 *
 * An empty operand never matches; a MALFORMED literal (bad regex syntax)
 * never matches either (`compileNameMatcher` logs it and falls back to an
 * exact compare against the literal text, which no property value equals).
 *
 * An UNSAFE pattern — syntactically valid but rejected by
 * `@ifc-lite/regex-guard` as catastrophic-backtracking-shaped or over the
 * length cap — is different: `compileNameMatcher` THROWS a plain `Error`
 * naming the pattern and reason, once, on the first row that reaches it.
 * This function does not catch that throw; it propagates out of
 * `stringOpMatches` / `matchStringAnyNone` / `valueOpMatches` and out of
 * `filter-evaluate.ts`'s per-entity loop. Every current caller of the
 * evaluator (`SearchModal.filter.tsx`'s `runFilter`, `resolveClashSetFilter`,
 * `query-adapter.ts`'s `entitiesMatchingActiveFilter`) already wraps its call
 * in a try/catch that turns this into a visible, recoverable error rather
 * than an unhandled exception — see those call sites for how each one
 * surfaces it. A new caller of `evaluateFilterRules` /
 * `evaluateFilterRulesFederated` MUST do the same.
 */
export function regexOpMatches(candidate: string, value: string, kind: TextKind | undefined): boolean {
  if (value.length === 0) return false;
  const literal = kind === undefined && isNamePattern(value) ? value : `/${value}/`;
  return compileNameMatcher(literal)(candidate ?? '');
}

export function setOpMatches(op: SetOp, candidate: string, values: readonly string[]): boolean {
  const c = lower(candidate);
  const hit = values.some((v) => lower(v) === c);
  return op === 'in' ? hit : !hit;
}

/**
 * `globalId` rule matching — exact, case-SENSITIVE, unlike every other
 * `SetOp` dimension in this module. A GlobalId is a 22-character base64
 * string (IFC's compressed GUID encoding), where upper/lower case is part of
 * the identity: folding case would let two DIFFERENT elements' GlobalIds
 * collide on an `in` match.
 */
export function globalIdOpMatches(op: SetOp, candidate: string, values: readonly string[]): boolean {
  const hit = values.includes(candidate);
  return op === 'in' ? hit : !hit;
}

/**
 * `candidate: string | undefined` — `undefined` means ABSENT (#4930), a real
 * input, decided explicitly here: a positive op never matches it, its
 * negation always does.
 */
export function stringOpMatches(
  op: StringOp,
  candidate: string | undefined,
  value: string,
  valueKind?: TextKind,
): boolean {
  if (candidate === undefined) {
    switch (op) {
      case 'eq':
      case 'contains':
      case 'startsWith':
      case 'matches':
        return false;
      case 'ne':
      case 'notContains':
      case 'notMatches':
        return true;
    }
  }
  const a = lower(candidate);
  const b = lower(value);
  switch (op) {
    case 'eq':          return a === b;
    case 'ne':          return a !== b;
    case 'contains':    return a.includes(b);
    case 'notContains': return !a.includes(b);
    case 'startsWith':  return a.startsWith(b);
    case 'matches':     return regexOpMatches(candidate, value, valueKind);
    case 'notMatches':  return !regexOpMatches(candidate, value, valueKind);
  }
}

/**
 * Match a StringOp against a *set* of candidates (materials, ancestors,
 * classification refs). Positive ops match if ANY satisfies them; negative
 * ops match only if NONE violates them; a `string | undefined` candidate is
 * handled per-entry by `stringOpMatches` (#4930). An empty LIST stays
 * distinct: "no candidates at all" never matches, negative ops included.
 */
export function matchStringAnyNone(
  op: StringOp,
  candidates: readonly (string | undefined)[],
  value: string,
  valueKind?: TextKind,
): boolean {
  if (candidates.length === 0) return false;
  switch (op) {
    case 'eq':
    case 'contains':
    case 'startsWith':
    case 'matches':
      return candidates.some((c) => stringOpMatches(op, c, value, valueKind));
    case 'ne':
      return candidates.every((c) => stringOpMatches('eq', c, value) === false);
    case 'notContains':
      return candidates.every((c) => stringOpMatches('contains', c, value) === false);
    case 'notMatches':
      return candidates.every((c) => stringOpMatches('matches', c, value, valueKind) === false);
  }
}

export function numericOpMatches(op: NumericOp, candidate: number, value: number): boolean {
  // The Rust side uses 1e-9 as the epsilon for eq/ne. Match it here for
  // IDS-style parity — IFC quantities are stored as IFC4 IfcReal so the
  // tolerance is large enough to absorb f32→f64 rounding from the parser.
  const EPS = 1e-9;
  switch (op) {
    case 'eq':  return Math.abs(candidate - value) < EPS;
    case 'ne':  return Math.abs(candidate - value) >= EPS;
    case 'gt':  return candidate > value;
    case 'gte': return candidate >= value;
    case 'lt':  return candidate < value;
    case 'lte': return candidate <= value;
  }
}

/**
 * Evaluate a Property ValueOp against the candidate's raw stringified
 * value. `isSet`/`isNotSet` are presence checks and the property layer
 * (filter-evaluate.ts) decides them before calling here — but we still
 * accept them so the function is total.
 */
export function valueOpMatches(
  op: ValueOp,
  psetVal: string,
  ruleVal: string,
  valueKind?: TextKind,
): boolean {
  switch (op) {
    case 'isSet':       return (psetVal ?? '').length > 0;
    case 'isNotSet':    return (psetVal ?? '').length === 0;
    case 'eq':          return lower(psetVal) === lower(ruleVal);
    case 'ne':          return lower(psetVal) !== lower(ruleVal);
    case 'contains':    return lower(psetVal).includes(lower(ruleVal));
    case 'notContains': return !lower(psetVal).includes(lower(ruleVal));
    case 'matches':     return regexOpMatches(psetVal, ruleVal, valueKind);
    case 'notMatches':  return !regexOpMatches(psetVal, ruleVal, valueKind);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cv = Number.parseFloat(psetVal);
      const rv = Number.parseFloat(ruleVal);
      if (!Number.isFinite(cv) || !Number.isFinite(rv)) return false;
      return numericOpMatches(op, cv, rv);
    }
  }
}
