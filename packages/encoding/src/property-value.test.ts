/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { parsePropertyValue } from './property-value.js';

describe('parsePropertyValue', () => {
  it('returns em-dash for null/undefined', () => {
    expect(parsePropertyValue(null).displayValue).toBe('\u2014');
    expect(parsePropertyValue(undefined).displayValue).toBe('\u2014');
  });

  it('resolves boolean enums', () => {
    expect(parsePropertyValue('.T.')).toEqual({ displayValue: 'True', ifcType: 'Boolean' });
    expect(parsePropertyValue('.F.')).toEqual({ displayValue: 'False', ifcType: 'Boolean' });
    expect(parsePropertyValue('.U.')).toEqual({ displayValue: 'Unknown', ifcType: 'Boolean' });
  });

  it('resolves typed value arrays', () => {
    const result = parsePropertyValue(['IFCIDENTIFIER', '100 x 150mm']);
    expect(result.displayValue).toBe('100 x 150mm');
    expect(result.ifcType).toBe('Identifier');
  });

  it('resolves typed boolean arrays', () => {
    const result = parsePropertyValue(['IFCBOOLEAN', '.T.']);
    expect(result.displayValue).toBe('True');
    expect(result.ifcType).toBe('Boolean');
  });

  it('resolves "IFCTYPE,value" string patterns', () => {
    const result = parsePropertyValue('IFCLABEL,Concrete');
    expect(result.displayValue).toBe('Concrete');
    expect(result.ifcType).toBe('Label');
  });

  it('resolves "IFCTYPE,value" case-insensitively (the regex carries an /i flag)', () => {
    const result = parsePropertyValue('ifclabel,Concrete');
    expect(result.displayValue).toBe('Concrete');
    expect(result.ifcType).toBe('Label');
  });

  it('resolves "IFCTYPE,.T." string pattern as boolean', () => {
    const result = parsePropertyValue('IFCBOOLEAN,.T.');
    expect(result.displayValue).toBe('True');
    expect(result.ifcType).toBe('Boolean');
  });

  it('returns em-dash for empty typed values', () => {
    const result = parsePropertyValue('IFCLABEL,');
    expect(result.displayValue).toBe('\u2014');
    expect(result.ifcType).toBe('Label');
  });

  it('handles native booleans', () => {
    expect(parsePropertyValue(true)).toEqual({ displayValue: 'True', ifcType: 'Boolean' });
    expect(parsePropertyValue(false)).toEqual({ displayValue: 'False', ifcType: 'Boolean' });
  });

  it('formats numbers', () => {
    // Production formats via `toLocaleString`, so the group/decimal
    // separators depend on the ambient locale ('3.141593' vs '3,141593').
    // Compare the digit sequence only: that is locale-agnostic but still
    // sensitive to how many fraction digits were kept.
    const digits = (s: string | undefined) => s?.replace(/[^0-9]/g, '');

    // Integer and non-integer take different formatting branches
    // (`Number.isInteger(value) ? ... : ...`); assert the digit sequence so
    // a branch swap is caught instead of just "some truthy string came out".
    const intResult = parsePropertyValue(42);
    expect(digits(intResult.displayValue)).toBe('42');
    expect(intResult.ifcType).toBeUndefined();

    // Non-integer is formatted with maximumFractionDigits: 6. If the
    // branches were swapped, this would instead go through the integer
    // branch's plain `toLocaleString()`, which defaults to 3 fraction
    // digits and would produce '3.142' -> digits '3142', failing this
    // assertion regardless of locale.
    const floatResult = parsePropertyValue(3.14159265);
    expect(digits(floatResult.displayValue)).toBe('3141593');
    expect(floatResult.ifcType).toBeUndefined();
  });

  // Decoding happens exactly ONCE, at the parse boundary — `EntityExtractor`
  // / `columnar-parser-attributes.ts` on the TypeScript path,
  // `AttributeValue::from_token` on the Rust/WASM and server paths. So the
  // value reaching this function is already literal text, and a second decode
  // is not a no-op: since #2394 `decodeIfcString` collapses `\\` to `\`, which
  // turned an authored UNC path into a wrong one on screen.
  //
  // Idempotence is not the alternative fix: it would require treating an
  // already-decoded `\` and an authored, still-doubled `\\` alike, which is
  // exactly the ambiguity #2394 removed.
  it('passes an already-decoded value through unchanged (no second decode)', () => {
    // What the parse path stores for the authored UNC path `\\server\share`.
    const stored = '\\\\server\\share';
    expect(parsePropertyValue(stored).displayValue).toBe(stored);
  });

  it('passes an already-decoded typed value through unchanged (both branches)', () => {
    // The tuple branch…
    const tuple = 'C:\\\\tuple\\logs';
    expect(parsePropertyValue(['IFCTEXT', tuple])).toEqual({
      displayValue: tuple,
      ifcType: 'Text',
    });
    // …and the `String(array)`-flattened branch, with a DISTINCT fixture so
    // neither assertion can be satisfied by the other branch's value.
    const flattened = 'C:\\\\flat\\logs';
    expect(parsePropertyValue(`IFCTEXT,${flattened}`)).toEqual({
      displayValue: flattened,
      ifcType: 'Text',
    });
  });

  it('does not decode STEP escapes — the parse path already did', () => {
    // A still-encoded literal arriving here would mean the PRODUCER skipped
    // its decode; that is a bug in the producer, not something to paper over
    // here, and papering over it is what double-collapses `\\`.
    expect(parsePropertyValue('Br\\X2\\00FC\\X0\\cke').displayValue)
      .toBe('Br\\X2\\00FC\\X0\\cke');
  });

  it('handles plain strings', () => {
    expect(parsePropertyValue('hello').displayValue).toBe('hello');
  });
});
