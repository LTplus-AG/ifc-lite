/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EXPRESS built-in functions (ISO 10303-11 §15). Where the standard leaves a
 * case open, the behaviour follows IfcOpenShell's rule runtime, the engine
 * behind the buildingSMART validation service: TYPEOF, USEDIN and QUERY of an
 * indeterminate operand give an empty aggregate.
 */

import { EntityInstance } from './instance.js';
import { isTrue } from './logic.js';
import type { Model } from './model.js';
import { BinaryValue, int, isAggregate, isSet, lowerBound, markSet, num, prim, StepInteger, Typed, type Aggregate, type Value } from './values.js';

function unwrap(v: Value): Value {
  return v instanceof Typed ? unwrap(v.value) : v;
}

export function sizeof(v: Value): Value {
  const a = unwrap(v);
  return isAggregate(a) ? a.length : undefined;
}

export function hiindex(v: Value): Value {
  const a = unwrap(v);
  return isAggregate(a) ? lowerBound(a) + a.length - 1 : undefined;
}

export function loindex(v: Value): Value {
  const a = unwrap(v);
  return isAggregate(a) ? lowerBound(a) : undefined;
}

export function exists(v: Value): boolean {
  return v !== undefined;
}

export function nvl(v: Value, fallback: Value): Value {
  return v !== undefined ? v : fallback;
}

function definedTypeChain(m: Model, typeName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let t = m.schema.type(typeName);
  while (t && !seen.has(t.name)) {
    seen.add(t.name);
    out.push(`${m.schema.typePrefix}.${t.name.toUpperCase()}`);
    t = t.kind === 'defined' && t.underlying.k === 'named' ? m.schema.type(t.underlying.name) : undefined;
  }
  return out;
}

export function typeOf(m: Model, v: Value): Value {
  if (v instanceof EntityInstance) return [...v.entity.typeofNames];
  if (v instanceof Typed) return definedTypeChain(m, v.type);
  const p = prim(v);
  if (typeof p === 'number') return v instanceof StepInteger ? ['INTEGER', 'NUMBER'] : ['REAL', 'NUMBER'];
  if (typeof p === 'string') return ['STRING'];
  if (typeof p === 'boolean') return ['BOOLEAN', 'LOGICAL'];
  if (p instanceof BinaryValue) return ['BINARY'];
  return [];
}

/** `'SCHEMA.NAME' IN TYPEOF(v)`, compiled to a membership test instead of building the set. */
export function typeIs(m: Model, v: Value, upperName: string): boolean {
  if (v instanceof EntityInstance) return v.entity.isA(upperName);
  if (v instanceof Typed) return definedTypeChain(m, v.type).some((n) => n.endsWith(`.${upperName}`));
  return false;
}

export function usedIn(m: Model, v: Value, role: Value): Value {
  if (!(v instanceof EntityInstance) || v.transient) return [];
  return m.usedIn(v, typeof role === 'string' ? role : '');
}

export function query(source: Value, predicate: (item: Value) => Value): Value {
  const a = unwrap(source);
  if (!isAggregate(a)) return [];
  const out = a.filter((item) => isTrue(predicate(item)));
  return isSet(a) ? markSet(out) : out;
}

/** `[a, b : n, ...]`; a repeat count applies to the item it follows. */
export function aggregate(items: Array<[Value, Value?]>): Aggregate {
  const out: Aggregate = [];
  for (const [value, repeat] of items) {
    if (repeat === undefined) {
      out.push(value);
      continue;
    }
    const n = int(repeat) ?? 0;
    for (let i = 0; i < n; i++) out.push(value);
  }
  return out;
}

function math(f: (x: number) => number): (v: Value) => Value {
  return (v) => {
    const x = num(v);
    if (x === undefined) return undefined;
    const r = f(x);
    return Number.isFinite(r) ? r : undefined;
  };
}

export const abs = math(Math.abs);
export const sqrt = math((x) => (x < 0 ? NaN : Math.sqrt(x)));
export const sin = math(Math.sin);
export const cos = math(Math.cos);
export const tan = math(Math.tan);
export const asin = math(Math.asin);
export const acos = math(Math.acos);
export const exp = math(Math.exp);
export const log = math((x) => (x <= 0 ? NaN : Math.log(x)));
export const log2 = math((x) => (x <= 0 ? NaN : Math.log2(x)));
export const log10 = math((x) => (x <= 0 ? NaN : Math.log10(x)));

export function atan(y: Value, x: Value): Value {
  const a = num(y);
  const b = num(x);
  if (a === undefined || b === undefined) return undefined;
  return Math.atan2(a, b);
}

export function odd(v: Value): Value {
  const n = int(v);
  return n === undefined ? undefined : Math.abs(n % 2) === 1;
}

export function blength(v: Value): Value {
  const b = unwrap(v);
  if (!(b instanceof BinaryValue)) return undefined;
  const unused = Number.parseInt(b.hex[0] ?? '0', 16);
  return Math.max(0, (b.hex.length - 1) * 4 - unused);
}

export function length(v: Value): Value {
  const s = prim(v);
  return typeof s === 'string' ? s.length : undefined;
}
