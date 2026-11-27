/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** EXPRESS three-valued logic (ISO 10303-11 §12.4). An indeterminate operand reads as UNKNOWN. */

import { prim, UNKNOWN, type Logical, type Value } from './values.js';

export function logical(v: Value): Logical {
  const p = prim(v);
  return p === true || p === false ? p : UNKNOWN;
}

export function not(v: Value): Logical {
  const l = logical(v);
  return l === UNKNOWN ? UNKNOWN : !l;
}

export function and(a: Value, b: () => Value): Logical {
  const l = logical(a);
  if (l === false) return false;
  const r = logical(b());
  if (r === false) return false;
  return l === true && r === true ? true : UNKNOWN;
}

export function or(a: Value, b: () => Value): Logical {
  const l = logical(a);
  if (l === true) return true;
  const r = logical(b());
  if (r === true) return true;
  return l === false && r === false ? false : UNKNOWN;
}

export function xor(a: Value, b: Value): Logical {
  const l = logical(a);
  const r = logical(b);
  return l === UNKNOWN || r === UNKNOWN ? UNKNOWN : l !== r;
}

/** IF, WHILE and UNTIL take their branch only on TRUE. */
export function isTrue(v: Value): boolean {
  return logical(v) === true;
}

/** A WHERE rule is violated only when it evaluates to FALSE. */
export function violated(v: Value): boolean {
  return logical(v) === false;
}
