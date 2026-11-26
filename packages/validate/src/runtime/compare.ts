/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS value (`=`), instance (`:=:`) and ordering comparisons. */

import { EntityInstance } from './instance.js';
import { not } from './logic.js';
import { BinaryValue, EnumValue, isAggregate, isSet, prim, Ref, UNKNOWN, type Logical, type Value } from './values.js';

const MAX_VALUE_DEPTH = 16;

function rank(v: Value): number {
  return v === false ? 0 : v === UNKNOWN ? 1 : 2;
}

function instancesEqual(a: EntityInstance, b: EntityInstance, depth: number): Logical {
  if (a === b) return true;
  if (a.entity !== b.entity || depth > MAX_VALUE_DEPTH) return false;
  return valuesEqual(a.attributes, b.attributes, depth + 1, a, b);
}

function resolveRef(v: Value, owner: EntityInstance): Value {
  return v instanceof Ref && owner.model ? owner.model.get(v.id) : v;
}

function valuesEqual(a: Value[], b: Value[], depth: number, ownerA?: EntityInstance, ownerB?: EntityInstance): Logical {
  if (a.length !== b.length) return false;
  if (isSet(a) && isSet(b)) {
    const remaining = b.slice();
    let uncertain = false;
    for (const member of a) {
      let possible = false;
      const index = remaining.findIndex(candidate => {
        const result = equal(member, candidate, depth, ownerA, ownerB);
        if (result === UNKNOWN) possible = true;
        return result === true;
      });
      if (index >= 0) remaining.splice(index, 1);
      else if (!possible) return false;
      else uncertain = true;
    }
    return uncertain ? UNKNOWN : true;
  }
  let unknown = false;
  for (let i = 0; i < a.length; i++) {
    const x = ownerA ? resolveRef(a[i], ownerA) : a[i];
    const y = ownerB ? resolveRef(b[i], ownerB) : b[i];
    if (x === undefined && y === undefined) continue;
    const r = equal(x, y, depth, ownerA, ownerB);
    if (r === false) return false;
    if (r === UNKNOWN) unknown = true;
  }
  return unknown ? UNKNOWN : true;
}

function equal(a: Value, b: Value, depth: number, ownerA?: EntityInstance, ownerB?: EntityInstance): Logical {
  const x = prim(ownerA ? resolveRef(a, ownerA) : a);
  const y = prim(ownerB ? resolveRef(b, ownerB) : b);
  if (x === undefined || y === undefined) return UNKNOWN;
  if (typeof x === 'number' || typeof x === 'string') return x === y;
  if (x === true || x === false || x === UNKNOWN) return y === true || y === false || y === UNKNOWN ? x === y : false;
  if (x instanceof EnumValue) return y instanceof EnumValue && x.name === y.name;
  if (x instanceof BinaryValue) return y instanceof BinaryValue && x.hex === y.hex;
  if (x instanceof EntityInstance) return y instanceof EntityInstance ? instancesEqual(x, y, depth) : false;
  if (isAggregate(x)) return isAggregate(y) ? valuesEqual(x, y, depth + 1, ownerA, ownerB) : false;
  return false;
}

export function eq(a: Value, b: Value): Logical {
  return equal(a, b, 0);
}

export function ne(a: Value, b: Value): Logical {
  return not(eq(a, b));
}

/** `:=:` compares entity instances by identity and everything else by value. */
export function same(a: Value, b: Value): Logical {
  if (a instanceof EntityInstance || b instanceof EntityInstance) {
    if (a === undefined || b === undefined) return UNKNOWN;
    return a === b;
  }
  return eq(a, b);
}

export function notSame(a: Value, b: Value): Logical {
  return not(same(a, b));
}

function order(a: Value, b: Value): number | undefined {
  const x = prim(a);
  const y = prim(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
  if ((x === true || x === false || x === UNKNOWN) && (y === true || y === false || y === UNKNOWN)) return rank(x) - rank(y);
  return undefined;
}

export function lt(a: Value, b: Value): Logical {
  const o = order(a, b);
  return o === undefined ? UNKNOWN : o < 0;
}

export function gt(a: Value, b: Value): Logical {
  const o = order(a, b);
  return o === undefined ? UNKNOWN : o > 0;
}

export function le(a: Value, b: Value): Logical {
  const o = order(a, b);
  return o === undefined ? UNKNOWN : o <= 0;
}

export function ge(a: Value, b: Value): Logical {
  const o = order(a, b);
  return o === undefined ? UNKNOWN : o >= 0;
}

/** `e IN agg`: membership by instance identity first, then by value. */
export function isIn(e: Value, agg: Value): Logical {
  if (e === undefined || !isAggregate(agg)) return UNKNOWN;
  for (const item of agg) {
    if (item === e || eq(e, item) === true) return true;
  }
  return false;
}

export function interval(low: Value, op1: '<' | '<=', item: Value, op2: '<' | '<=', high: Value): Logical {
  const a = op1 === '<' ? lt(low, item) : le(low, item);
  const b = op2 === '<' ? lt(item, high) : le(item, high);
  if (a === false || b === false) return false;
  return a === true && b === true ? true : UNKNOWN;
}
