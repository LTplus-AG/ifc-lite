/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS arithmetic, string concatenation and aggregate set operators. */

import { EvaluationError } from './errors.js';
import { eq } from './compare.js';
import { copyAggregate, BinaryValue, EnumValue, StepReal, Typed, isAggregate, isSet, markSet, num, prim, type Aggregate, type Value } from './values.js';

function realOperand(v: Value): boolean {
  while (v instanceof Typed) v = v.value;
  return v instanceof StepReal || (typeof v === 'number' && !Number.isInteger(v));
}

function numeric(a: Value, b: Value, f: (x: number, y: number) => number, kind: 'promote' | 'real' | 'integer' = 'promote'): Value {
  const x = num(a);
  const y = num(b);
  if (x === undefined || y === undefined) return undefined;
  const result = f(x, y);
  if (!Number.isFinite(result)) return undefined;
  const real = kind === 'real' || (kind === 'promote' && (realOperand(a) || realOperand(b)));
  return real && Number.isInteger(result) ? new StepReal(result) : result;
}

function contains(agg: Aggregate, v: Value): boolean {
  return agg.some((x) => x === v || eq(x, v) === true);
}

/** Identity key for SET membership: value for primitives and enumerations, `undefined` for structured values. */
function memberKey(v: Value): string | undefined {
  if (v instanceof Typed) {
    const inner = memberKey(v.value);
    return inner === undefined ? undefined : JSON.stringify([v.type.toUpperCase(), inner]);
  }
  const p = prim(v);
  switch (typeof p) {
    case 'string': return `s${p}`;
    case 'number': return `n${p}`;
    case 'boolean': return `b${p}`;
  }
  if (p instanceof BinaryValue) return `binary:${p.hex}`;
  return p instanceof EnumValue ? `e${p.name}` : undefined;
}

/** Members of `items` appended to `base` (itself already unique), keeping SET uniqueness. */
export function uniqueMembers(items: Aggregate, base: Aggregate = []): Aggregate {
  const out = copyAggregate(base);
  const keys = new Set<string>();
  const taggedValues = new Set<string>();
  const objects = new Set<Value>();
  const structured: Value[] = [];
  const remember = (x: Value) => {
    const key = memberKey(x);
    if (key !== undefined) {
      keys.add(key);
      if (x instanceof Typed) taggedValues.add(memberKey(prim(x))!);
    }
    else if (isAggregate(x) || x instanceof Typed) structured.push(x);
    else objects.add(x);
  };
  for (const x of out) remember(x);
  for (const x of items) {
    const key = memberKey(x);
    // A bare primitive equals a tagged copy of that value, while two tagged
    // members must agree on their defined type as well.
    const seen = key !== undefined
      ? keys.has(key) || (x instanceof Typed ? keys.has(memberKey(prim(x))!) : taggedValues.has(key))
      : (isAggregate(x) || x instanceof Typed) ? structured.some(y => eq(x, y) === true) : objects.has(x);
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
  return numeric(a, b, (p, q) => p + q);
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
  return numeric(a, b, (p, q) => (q === 0 ? NaN : p / q), 'real');
}

export function intDiv(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => (q === 0 ? NaN : Math.trunc(p / q)), 'integer');
}

export function mod(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => (q === 0 ? NaN : p - q * Math.floor(p / q)), 'integer');
}

export function pow(a: Value, b: Value): Value {
  return numeric(a, b, (p, q) => p ** q);
}

export function neg(a: Value): Value {
  return numeric(0, a, (zero, x) => zero - x);
}

export function pos(a: Value): Value {
  return numeric(0, a, (zero, x) => zero + x);
}
