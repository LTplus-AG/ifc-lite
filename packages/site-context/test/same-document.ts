/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact equality of two site-context values, fast. vitest's `toEqual` walks a
 * typed array element by element through its generic equality: on the 4.7 MB
 * sample document that alone took about 2.1 s locally, warm, every time, and
 * over the 5 s test timeout on a loaded CI runner (#10480 queue run). Here
 * each typed array is compared as bytes (same constructor, same byte length,
 * same bytes, so -0, NaN payloads and every bit count), and everything else is
 * handed to `toEqual` with the arrays replaced by placeholders.
 */

import { expect } from 'vitest';

type Typed = ArrayBufferView;

function strip(value: unknown, arrays: Typed[]): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    arrays.push(value);
    return { typedArray: value.constructor.name, byteLength: value.byteLength, index: arrays.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => strip(v, arrays));
  if (value && typeof value === 'object') {
    // Sorted keys: the numbering of typed arrays must not depend on property order.
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, strip((value as Record<string, unknown>)[k], arrays)]));
  }
  return value;
}

function bytes(a: Typed): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

export function expectSameDocument(actual: unknown, expected: unknown): void {
  const a: Typed[] = [];
  const e: Typed[] = [];
  expect(strip(actual, a)).toEqual(strip(expected, e));
  for (let i = 0; i < e.length; i++) {
    if (Buffer.compare(bytes(a[i]), bytes(e[i])) !== 0) {
      throw new Error(`typed array #${i} (${e[i].constructor.name}, ${e[i].byteLength} bytes) differs`);
    }
  }
}
