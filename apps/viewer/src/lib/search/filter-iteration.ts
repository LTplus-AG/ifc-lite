/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function isNumericArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object' && value !== null
    && typeof (value as { length?: unknown }).length === 'number';
}

export function toNumericIterable(
  source: ArrayLike<number> | Iterable<number>,
): Iterable<number> {
  if (Symbol.iterator in Object(source)) return source as Iterable<number>;
  return (function* () {
    const arr = source as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) yield arr[i];
  })();
}

/** Materialise known-size collections for indexed chunking and progress. */
export function materialiseNumericIterable(
  source: ArrayLike<number> | Iterable<number>,
): ArrayLike<number> | null {
  if (Array.isArray(source) || isNumericArrayLike(source)) return source;
  if (source instanceof Set) return Array.from(source);
  return null;
}
