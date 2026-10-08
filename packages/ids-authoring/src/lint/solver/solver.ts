/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constraint intersection solver (03-diagnostics-audit-lint.md §3, SPEC-001
 * / SPEC-002 / SPEC-003).
 *
 * Answers are three-valued. `'yes'` and `'no'` are only returned when they
 * are certain:
 *
 * - finite sets (simpleValue, enumeration) are decided exactly by membership,
 *   using the validator's own `matchConstraint` (so `and` siblings, numeric
 *   casting and pattern translation agree with what a check would do);
 * - numeric intervals are decided exactly;
 * - patterns can only be proven to OVERLAP, by a sampled witness that the
 *   validator accepts under both constraints. Disjointness or containment of
 *   two patterns is never claimed (`'unknown'`).
 */

import { matchConstraint, type IDSBoundsConstraint, type IDSConstraint } from '@ifc-lite/ids';
import { samplePattern } from './sample.js';

export type Tri = 'yes' | 'no' | 'unknown';

export interface SolveOptions {
  /** Entity names compare case-insensitively; values do not. */
  caseInsensitive?: boolean;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Does `v` satisfy `c`, as a string or (when numeric) as a number? */
export function member(c: IDSConstraint, v: string, opts: SolveOptions = {}): boolean {
  const o = { caseInsensitive: opts.caseInsensitive ?? false };
  if (matchConstraint(c, v, o)) return true;
  return NUMBER.test(v.trim()) && matchConstraint(c, Number(v), o);
}

/** The finite value set of a constraint, or undefined when it is not finite. */
export function finiteValues(c: IDSConstraint, opts: SolveOptions = {}): string[] | undefined {
  let values: string[] | undefined;
  if (c.type === 'simpleValue') values = [c.value];
  else if (c.type === 'enumeration') values = c.values;
  else if (c.type === 'bounds' && point(c) !== undefined) values = [String(point(c))];
  return values?.filter((v) => member(c, v, opts));
}

interface Interval {
  lo: number;
  loEx: boolean;
  hi: number;
  hiEx: boolean;
}

const LENGTH_OR_DIGITS = ['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits'] as const;

/** The numeric interval of a pure bounds constraint. */
export function interval(c: IDSConstraint): Interval | undefined {
  if (c.type !== 'bounds' || c.and?.length || c.unparseableFacets?.length) return undefined;
  if (LENGTH_OR_DIGITS.some((k) => c[k] !== undefined)) return undefined;
  const lo = c.minInclusive ?? c.minExclusive;
  const hi = c.maxInclusive ?? c.maxExclusive;
  if (lo === undefined && hi === undefined) return undefined;
  return {
    lo: lo ?? -Infinity,
    loEx: c.minInclusive === undefined && c.minExclusive !== undefined,
    hi: hi ?? Infinity,
    hiEx: c.maxInclusive === undefined && c.maxExclusive !== undefined,
  };
}

function point(c: IDSBoundsConstraint): number | undefined {
  const i = interval(c);
  return i && i.lo === i.hi && !i.loEx && !i.hiEx ? i.lo : undefined;
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo < hi) return true;
  if (lo > hi) return false;
  const loEx = (a.lo === lo && a.loEx) || (b.lo === lo && b.loEx);
  const hiEx = (a.hi === hi && a.hiEx) || (b.hi === hi && b.hiEx);
  return !loEx && !hiEx;
}

function intervalWithin(a: Interval, b: Interval): boolean {
  const loOk = a.lo > b.lo || (a.lo === b.lo && (!b.loEx || a.loEx));
  const hiOk = a.hi < b.hi || (a.hi === b.hi && (!b.hiEx || a.hiEx));
  return loOk && hiOk;
}

function patternsOf(c: IDSConstraint): string[] {
  const own = c.type === 'pattern' ? [c.pattern] : [];
  const siblings = c.type === 'simpleValue' ? [] : (c.and ?? []).flatMap((s) => (s.type === 'pattern' ? [s.pattern] : []));
  return [...own, ...siblings];
}

/** A sampled value that satisfies both constraints, if one is found. */
function witness(a: IDSConstraint, b: IDSConstraint, opts: SolveOptions): string | undefined {
  for (const p of [...patternsOf(a), ...patternsOf(b)]) {
    for (const s of samplePattern(p)) if (member(a, s, opts) && member(b, s, opts)) return s;
  }
  return undefined;
}

function sameConstraint(a: IDSConstraint, b: IDSConstraint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Is there a value satisfying both `a` and `b`? */
export function overlaps(a: IDSConstraint, b: IDSConstraint, opts: SolveOptions = {}): Tri {
  if (sameConstraint(a, b)) return finiteValues(a, opts)?.length === 0 ? 'no' : 'yes';
  const fa = finiteValues(a, opts);
  if (fa) return fa.some((v) => member(b, v, opts)) ? 'yes' : 'no';
  const fb = finiteValues(b, opts);
  if (fb) return fb.some((v) => member(a, v, opts)) ? 'yes' : 'no';
  const ia = interval(a);
  const ib = interval(b);
  if (ia && ib) return intervalsOverlap(ia, ib) ? 'yes' : 'no';
  return witness(a, b, opts) !== undefined ? 'yes' : 'unknown';
}

/** Does every value satisfying `a` also satisfy `b`? */
export function implies(a: IDSConstraint, b: IDSConstraint, opts: SolveOptions = {}): Tri {
  if (sameConstraint(a, b)) return 'yes';
  const fa = finiteValues(a, opts);
  if (fa) return fa.every((v) => member(b, v, opts)) ? 'yes' : 'no';
  const ia = interval(a);
  const ib = interval(b);
  if (ia && ib) return intervalWithin(ia, ib) ? 'yes' : 'no';
  if (ia && finiteValues(b, opts)) return 'no'; // a non-degenerate interval is infinite
  return 'unknown';
}
