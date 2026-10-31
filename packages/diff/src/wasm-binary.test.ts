/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { packDocument, packStrings, unpackDocument } from './wasm-binary.js';

describe('#8042 binary transport', () => {
  it('preserves UTF-16 units, nonfinite tokens, signed zero and own key order', () => {
    const value = Object.fromEntries([
      ['\ud800', '\udfff'], ['__proto__', { empty: '', array: [] }],
      ['numbers', [NaN, Infinity, -Infinity, -0]],
    ]);
    const result = unpackDocument(packDocument(value));
    expect(result).toEqual(value);
    expect(Object.keys(result as object)).toEqual(Object.keys(value));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
  it('distinguishes absent, null and empty fields', () => {
    const values = [{}, { value: null }, { value: '' }, { value: [] }];
    expect(unpackDocument(packDocument(values))).toEqual(values);
  });
});

// #8042: the fast path accepts duplicate dictionary values and lone surrogates.
it('typed dictionary preserves the generic string-array contract', () => {
  for (const values of [[], ['', '__proto__', '\ud800', '\udfff', 'same', 'same']]) {
    expect(unpackDocument(packStrings(values))).toEqual(values);
    expect(unpackDocument(packStrings(values))).toEqual(unpackDocument(packDocument(values)));
  }
});
