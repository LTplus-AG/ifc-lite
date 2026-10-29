/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { packDocument, unpackDocument } from './wasm-binary.js';

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
