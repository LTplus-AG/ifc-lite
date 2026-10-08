/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Value well-formedness (GATE-VAL-00x). Runs on the normalised
 * `IDSConstraint`, so drafts and raw constraints get the same checks, and
 * recurses into the conjunctive `and` siblings (which the IDS audit does
 * not lint).
 *
 * Patterns go through the same XSD → JS translator and ReDoS guard the
 * validator uses, so a pattern the gate accepts is one the checker can run.
 */

import type { IDSBoundsConstraint, IDSConstraint } from '@ifc-lite/ids';
import { translateXsdRegex } from '@ifc-lite/ids';
import { assertGuardedRegexPattern, UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import type { GateCode } from './types.js';

export interface ValueProblem {
  code: GateCode;
  message: string;
}

const NUMERIC_BASES = new Set(['xs:double', 'xs:decimal', 'xs:float', 'xs:integer']);
const XSD_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const XSD_DOUBLE = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const XSD_INTEGER = /^[+-]?\d+$/;

function numericLiteralOk(base: string, value: string): boolean {
  const v = value.trim();
  if (base === 'xs:integer') return XSD_INTEGER.test(v);
  if (base === 'xs:decimal') return XSD_DECIMAL.test(v);
  return XSD_DOUBLE.test(v);
}

/** Lexical check of one literal against a restriction base. */
function literalOk(base: string | undefined, value: string): boolean {
  if (!base) return true;
  if (NUMERIC_BASES.has(base)) return numericLiteralOk(base, value);
  if (base === 'xs:boolean') return ['true', 'false', '1', '0'].includes(value.trim());
  return true;
}

export function checkPattern(pattern: string): ValueProblem[] {
  if (pattern === '') return [{ code: 'GATE-VAL-003', message: 'pattern is empty' }];
  try {
    assertGuardedRegexPattern(pattern);
  } catch (err) {
    const reason = err instanceof UnsafeRegexPatternError ? err.reason : String(err);
    return [{ code: 'GATE-VAL-004', message: `pattern "${pattern}" is rejected by the ReDoS guard: ${reason}` }];
  }
  const translated = translateXsdRegex(pattern);
  try {
    new RegExp(`^(?:${translated.pattern})$`, 'u');
  } catch (err) {
    return [{ code: 'GATE-VAL-003', message: `pattern "${pattern}" does not compile: ${err instanceof Error ? err.message : String(err)}` }];
  }
  return [];
}

function lower(b: IDSBoundsConstraint): { v: number; exclusive: boolean } | undefined {
  if (b.minExclusive !== undefined) return { v: b.minExclusive, exclusive: true };
  if (b.minInclusive !== undefined) return { v: b.minInclusive, exclusive: false };
  return undefined;
}

function upper(b: IDSBoundsConstraint): { v: number; exclusive: boolean } | undefined {
  if (b.maxExclusive !== undefined) return { v: b.maxExclusive, exclusive: true };
  if (b.maxInclusive !== undefined) return { v: b.maxInclusive, exclusive: false };
  return undefined;
}

function checkBounds(b: IDSBoundsConstraint): ValueProblem[] {
  const out: ValueProblem[] = [];
  const keys = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits'] as const;
  for (const k of keys) {
    const v = b[k];
    if (v !== undefined && !Number.isFinite(v)) out.push({ code: 'GATE-VAL-001', message: `${k} must be a finite number` });
  }
  if (b.minInclusive !== undefined && b.minExclusive !== undefined) {
    out.push({ code: 'GATE-VAL-002', message: 'minInclusive and minExclusive cannot both be set' });
  }
  if (b.maxInclusive !== undefined && b.maxExclusive !== undefined) {
    out.push({ code: 'GATE-VAL-002', message: 'maxInclusive and maxExclusive cannot both be set' });
  }
  const lo = lower(b);
  const hi = upper(b);
  if (lo && hi && (lo.v > hi.v || (lo.v === hi.v && (lo.exclusive || hi.exclusive)))) {
    out.push({ code: 'GATE-VAL-002', message: `lower bound ${lo.v} is not below upper bound ${hi.v}; no value can match` });
  }
  for (const k of ['length', 'minLength', 'maxLength', 'fractionDigits'] as const) {
    const v = b[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) out.push({ code: 'GATE-VAL-005', message: `${k} must be a non-negative integer` });
  }
  if (b.totalDigits !== undefined && (!Number.isInteger(b.totalDigits) || b.totalDigits < 1)) {
    out.push({ code: 'GATE-VAL-005', message: 'totalDigits must be a positive integer' });
  }
  if (b.minLength !== undefined && b.maxLength !== undefined && b.minLength > b.maxLength) {
    out.push({ code: 'GATE-VAL-005', message: `minLength ${b.minLength} exceeds maxLength ${b.maxLength}` });
  }
  if (b.totalDigits !== undefined && b.fractionDigits !== undefined && b.fractionDigits > b.totalDigits) {
    out.push({ code: 'GATE-VAL-005', message: `fractionDigits ${b.fractionDigits} exceeds totalDigits ${b.totalDigits}` });
  }
  if (b.unparseableFacets?.length) {
    out.push({ code: 'GATE-VAL-006', message: `unparseable facets: ${b.unparseableFacets.map((f) => `${f.facet}="${f.rawValue}"`).join(', ')}` });
  }
  return out;
}

/** Every well-formedness problem of `c` (including its `and` siblings). */
export function checkConstraint(c: IDSConstraint, base?: string): ValueProblem[] {
  switch (c.type) {
    case 'simpleValue':
      return [];
    case 'pattern':
      return [...checkPattern(c.pattern), ...siblings(c.and, c.base ?? base)];
    case 'enumeration': {
      const out: ValueProblem[] = [];
      if (c.values.length === 0) out.push({ code: 'GATE-VAL-001', message: 'enumeration has no values' });
      const b = c.base ?? base;
      for (const v of c.values) {
        if (!literalOk(b, v)) out.push({ code: 'GATE-VAL-006', message: `"${v}" is not a valid ${b} literal` });
      }
      return [...out, ...siblings(c.and, b)];
    }
    case 'bounds':
      return [...checkBounds(c), ...siblings(c.and, c.base ?? base)];
  }
}

function siblings(and: readonly IDSConstraint[] | undefined, base: string | undefined): ValueProblem[] {
  return (and ?? []).flatMap((s) => checkConstraint(s, base));
}
