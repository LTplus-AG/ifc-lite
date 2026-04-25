/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unified filter rule taxonomy.
 *
 * Ported from the Tauri-side `filter.rs` engine and consumed by the
 * in-memory path-B runtime evaluator (`filter-evaluate.ts`). The
 * discriminated-union shape lets the chip UI serialise any rule as a
 * JSON object with a `"kind"` discriminator, mirroring serde's tagged
 * enum encoding. We use `kind` rather than `type` because `type`
 * collides with the IFC `type` attribute name on element rows.
 */

// ── Operator enums ────────────────────────────────────────────────────────────

/** Set-membership: storey, ifcType, predefinedType. */
export type SetOp = 'in' | 'notIn';

/** String comparisons (Name rule). */
export type StringOp = 'eq' | 'ne' | 'contains' | 'notContains' | 'startsWith';

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
  | 'isSet'
  | 'isNotSet';

/** Top-level rule combinator. */
export type Combinator = 'AND' | 'OR';

// ── Rule discriminated union ──────────────────────────────────────────────────

export interface StoreyRule {
  kind: 'storey';
  values: string[];
  op: SetOp;
}

export interface IfcTypeRule {
  kind: 'ifcType';
  values: string[];
  op: SetOp;
}

export interface PredefinedTypeRule {
  kind: 'predefinedType';
  values: string[];
  op: SetOp;
}

export interface NameRule {
  kind: 'name';
  op: StringOp;
  value: string;
}

export interface PropertyRule {
  kind: 'property';
  setName: string;
  propertyName: string;
  op: ValueOp;
  /** Raw user input. Numeric ops parse as f64; isSet/isNotSet ignore. */
  value: string;
}

export interface QuantityRule {
  kind: 'quantity';
  setName: string;
  quantityName: string;
  op: NumericOp;
  value: number;
}

export type FilterRule =
  | StoreyRule
  | IfcTypeRule
  | PredefinedTypeRule
  | NameRule
  | PropertyRule
  | QuantityRule;

// ── Pure op helpers (ported verbatim from filter.rs) ──────────────────────────

export function setOpMatches(op: SetOp, candidate: string, values: readonly string[]): boolean {
  const hit = values.some((v) => v.toLowerCase() === candidate.toLowerCase());
  return op === 'in' ? hit : !hit;
}

export function stringOpMatches(op: StringOp, candidate: string, value: string): boolean {
  const a = candidate.toLowerCase();
  const b = value.toLowerCase();
  switch (op) {
    case 'eq':          return a === b;
    case 'ne':          return a !== b;
    case 'contains':    return a.includes(b);
    case 'notContains': return !a.includes(b);
    case 'startsWith':  return a.startsWith(b);
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
export function valueOpMatches(op: ValueOp, psetVal: string, ruleVal: string): boolean {
  switch (op) {
    case 'isSet':       return psetVal.length > 0;
    case 'isNotSet':    return psetVal.length === 0;
    case 'eq':          return psetVal.toLowerCase() === ruleVal.toLowerCase();
    case 'ne':          return psetVal.toLowerCase() !== ruleVal.toLowerCase();
    case 'contains':    return psetVal.toLowerCase().includes(ruleVal.toLowerCase());
    case 'notContains': return !psetVal.toLowerCase().includes(ruleVal.toLowerCase());
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

// ── Combinator helpers ────────────────────────────────────────────────────────

/** Combine an array of per-rule booleans according to AND/OR semantics. */
export function combineRuleResults(combinator: Combinator, results: readonly boolean[]): boolean {
  if (results.length === 0) return false;
  return combinator === 'AND' ? results.every((r) => r) : results.some((r) => r);
}

// ── Convenience constructors ──────────────────────────────────────────────────
//
// The chip UI builds rules via `set*` slice actions (see searchSlice.ts);
// these helpers exist primarily for tests and for code paths that synthesize
// rules from a different representation (URL state, presets).

export const Rule = {
  storey: (values: string[], op: SetOp = 'in'): StoreyRule => ({ kind: 'storey', values, op }),
  ifcType: (values: string[], op: SetOp = 'in'): IfcTypeRule => ({ kind: 'ifcType', values, op }),
  predefinedType: (values: string[], op: SetOp = 'in'): PredefinedTypeRule =>
    ({ kind: 'predefinedType', values, op }),
  name: (op: StringOp, value: string): NameRule => ({ kind: 'name', op, value }),
  property: (setName: string, propertyName: string, op: ValueOp, value: string): PropertyRule =>
    ({ kind: 'property', setName, propertyName, op, value }),
  quantity: (setName: string, quantityName: string, op: NumericOp, value: number): QuantityRule =>
    ({ kind: 'quantity', setName, quantityName, op, value }),
} as const;

// ── JSON guards ──────────────────────────────────────────────────────────────

const SET_OPS_VALID: ReadonlySet<string> = new Set(['in', 'notIn']);
const STRING_OPS_VALID: ReadonlySet<string> = new Set([
  'eq', 'ne', 'contains', 'notContains', 'startsWith',
]);
const NUMERIC_OPS_VALID: ReadonlySet<string> = new Set([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
]);
const VALUE_OPS_VALID: ReadonlySet<string> = new Set([
  'eq', 'ne', 'contains', 'notContains',
  'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
]);

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string');
}

/**
 * Validate the per-kind shape of a candidate rule. The store-side
 * action types guarantee well-formed rules at runtime; this guard
 * exists to defend the *deserialise* boundary — `parseFilterRules`
 * gates restored localStorage presets in `saved-filters.ts`, and a
 * tampered or malformed payload like `{ kind: 'ifcType' }` (no
 * `values`) would otherwise reach the evaluator's `rule.values.some(…)`
 * and crash. Per-kind narrowing keeps the surface tight.
 */
export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  switch (o.kind) {
    case 'storey':
    case 'ifcType':
    case 'predefinedType':
      return isStringArray(o.values) && typeof o.op === 'string' && SET_OPS_VALID.has(o.op);
    case 'name':
      return typeof o.value === 'string' && typeof o.op === 'string' && STRING_OPS_VALID.has(o.op);
    case 'property':
      return (
        typeof o.setName === 'string' &&
        typeof o.propertyName === 'string' &&
        typeof o.value === 'string' &&
        typeof o.op === 'string' &&
        VALUE_OPS_VALID.has(o.op)
      );
    case 'quantity':
      return (
        typeof o.setName === 'string' &&
        typeof o.quantityName === 'string' &&
        typeof o.value === 'number' &&
        Number.isFinite(o.value) &&
        typeof o.op === 'string' &&
        NUMERIC_OPS_VALID.has(o.op)
      );
    default:
      return false;
  }
}

export function parseFilterRules(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterRule);
}
