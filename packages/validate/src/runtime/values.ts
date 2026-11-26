/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runtime values of compiled EXPRESS. `undefined` is the indeterminate value
 * `?`; {@link UNKNOWN} is the third LOGICAL value. INTEGER literals read from
 * STEP stay {@link StepInteger} so a REAL slot can reject them, as strict
 * validators do; arithmetic and comparison unwrap them through {@link prim}.
 */

import type { EntityInstance } from './instance.js';

export const UNKNOWN: unique symbol = Symbol('UNKNOWN');
export type Unknown = typeof UNKNOWN;

/** STEP `*`: the value is computed by a DERIVE redeclaration. */
export const DERIVED: unique symbol = Symbol('DERIVED');
export type Derived = typeof DERIVED;

export class StepInteger {
  constructor(readonly value: number) {}
}

/** Retains the REAL token kind when its numeric value is integral. */
export class StepReal {
  constructor(readonly value: number) {}
}

export class Ref {
  constructor(readonly id: number) {}
}

export class EnumValue {
  constructor(readonly name: string) {}
}

export class BinaryValue {
  constructor(readonly hex: string) {}
}

/** A value qualified by its defined type, `IFCLABEL('x')` in STEP. */
export class Typed {
  constructor(readonly type: string, readonly value: Value) {}
}

export type Logical = boolean | Unknown;

export type Value =
  | undefined
  | boolean
  | Unknown
  | Derived
  | number
  | string
  | StepReal
  | StepInteger
  | Ref
  | EnumValue
  | BinaryValue
  | Typed
  | EntityInstance
  | Aggregate;

export const LOWER_BOUND: unique symbol = Symbol('LOWER_BOUND');
/** Marks an aggregate with SET semantics: union, difference and intersection keep members unique. */
export const IS_SET: unique symbol = Symbol('IS_SET');

export interface Aggregate extends Array<Value> {
  [LOWER_BOUND]?: number;
  [IS_SET]?: true;
}

export function isSet(v: Value): boolean {
  return Array.isArray(v) && v[IS_SET] === true;
}

export function markSet(a: Aggregate): Aggregate {
  a[IS_SET] = true;
  return a;
}

export function isAggregate(v: Value): v is Aggregate {
  return Array.isArray(v);
}

export function lowerBound(a: Aggregate): number {
  return a[LOWER_BOUND] ?? 1;
}

export function withLowerBound(a: Aggregate, low: number): Aggregate {
  if (low !== 1) a[LOWER_BOUND] = low;
  else delete a[LOWER_BOUND];
  return a;
}

/** Copy an aggregate keeping its index base, so EXPRESS value semantics hold on assignment. */
export function copyAggregate(a: Aggregate): Aggregate {
  const out: Aggregate = a.map(v => isAggregate(v) ? copyAggregate(v) : v);
  const low = a[LOWER_BOUND];
  if (low !== undefined) out[LOWER_BOUND] = low;
  if (a[IS_SET]) out[IS_SET] = true;
  return out;
}

/** Strip STEP integer and defined-type wrappers down to the underlying primitive. */
export function prim(v: Value): Value {
  while (v instanceof Typed) v = v.value;
  return v instanceof StepInteger || v instanceof StepReal ? v.value : v;
}

export function num(v: Value): number | undefined {
  const p = prim(v);
  return typeof p === 'number' ? p : undefined;
}

export function int(v: Value): number | undefined {
  const n = num(v);
  return n === undefined || !Number.isFinite(n) ? undefined : Math.trunc(n);
}
