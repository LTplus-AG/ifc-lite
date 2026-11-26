/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS arithmetic, string concatenation and aggregate set operators. */

import { EvaluationError } from './errors.js';
import { eq } from './compare.js';
import { copyAggregate, EnumValue, isAggregate, isSet, markSet, num, prim, type Aggregate, type Value } from './values.js';

function numeric(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  const x = num(a);
  const y = num(b);
  if (x === undefined || y === undefined) return undefined;
  const r = f(x, y);
  return Number.isFinite(r) ? r : undefined;
}

function contains(agg: Aggregate, v: Value): boolean {
  return agg.some((x) => x === v || eq(x, v) === true);
}

/** Identity key for SET membership: value for primitives and enumerations, `undefined` for structured values. */
function memberKey(v: Value): string | undefined {
  const p = prim(v);
  switch (typeof p) {
    case 'string': return `s${p}`;
    case 'number': return `n${p}`;
    case 'boolean': return `b${p}`;
  }
  return p instanceof EnumValue ? `e${p.name}` : undefined;
}

/** Members of `items` appended to `base` (itself already unique), keeping SET uniqueness. */
export function uniqueMembers(items: Aggregate, base: Aggregate = []): Aggregate {
  const out = copyAggregate(base);
  const keys = new Set<string>();
  const objects = new Set<Value>();
  const structured: Value[] = [];
  const remember = (x: Value) => {
    const key = memberKey(x);
    if (key !== undefined) keys.add(key);
    else if (isAggregate(x)) structured.push(x);
    else objects.add(x);
  };
  for (const x of out) remember(x);
  for (const x of items) {
    const key = memberKey(x);
    const seen = key !== undefined ? keys.has(key) : isAggregate(x) ? structured.some((y) => eq(x, y) === true) : objects.has(x);
    if (seen) continue;
    remember(x);
    out.push(x);
  }
  return markSet(out);
}

/**
 * A SET operand that meets an indeterminate one is an evaluation error, not
 * an indeterminate result: a set cannot hold `?`, and IfcOpenShell (the bSI
 * validation service) fails the rule there too.
 */
function setOperands(a: Value, b: Value): boolean {
  const set = isSet(a) || isSet(b);
  if (set && (a === undefined || b === undefined)) throw new EvaluationError('indeterminate operand in a SET operation');
  return set;
}

export function add(a: Value, b: Value): Value {
  const set = setOperands(a, b);
  if (a === undefined || b === undefined) return undefined;
  if (isAggregate(a)) {
    if (set) return isSet(a) ? uniqueMembers(isAggregate(b) ? b : [b], a) : uniqueMembers(isAggregate(b) ? [...a, ...b] : [...a, b]);
    const out: Aggregate = isAggregate(b) ? [...a, ...b] : [...a, b];
    return out;
  }
  if (isAggregate(b)) {
    const out: Aggregate = [a, ...b];
    return set ? uniqueMembers(out) : out;
  }
  const x = prim(a);
  const y = prim(b);
  if (typeof x === 'string' && typeof y === 'string') return x + y;
  return numeric(x, y, (p, q) => p + q);
}

export function sub(a: Value, b: Value): Value {
  const set = setOperands(a, b);
  if (a === undefined || b === undefined) return undefined;
  if (isAggregate(a)) {
    const out = isAggregate(b) ? a.filter((x) => !contains(b, x)) : [...a];
    if (!isAggregate(b)) {
      const at = out.findIndex((x) => x === b || eq(x, b) === true);
      if (at >= 0) out.splice(at, 1);
    }
    return set ? markSet(out) : out;
  }
  return numeric(a, b, (p, q) => p - q);
}

export function mul(a: Value, b: Value): Value {
  const set = setOperands(a, b);
  if (a === undefined || b === undefined) return undefined;
  if (isAggregate(a) && isAggregate(b)) {
    const out = a.filter((x) => contains(b, x));
    return set ? uniqueMembers(out) : out;
  }
  return numeric(a, b, (p, q) => p * q);
}

export function div(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => (q === 0 ? NaN : p / q));
}

export function intDiv(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => (q === 0 ? NaN : Math.trunc(p / q)));
}

export function mod(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => (q === 0 ? NaN : p - q * Math.floor(p / q)));
}

export function pow(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => p ** q);
}

export function neg(a: Value): Value {
  const x = num(a);
  return x === undefined ? undefined : -x;
}

export function pos(a: Value): Value {
  return num(a);
}
