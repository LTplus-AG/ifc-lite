/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { decodeIfcString, encodeIfcString } from './ifc-string.js';

describe('decodeIfcString', () => {
  it('returns plain strings unchanged', () => {
    expect(decodeIfcString('Hello World')).toBe('Hello World');
  });

  it('handles null/undefined/empty', () => {
    expect(decodeIfcString('')).toBe('');
    expect(decodeIfcString(null as unknown as string)).toBe(null);
    expect(decodeIfcString(undefined as unknown as string)).toBe(undefined);
  });

  it('decodes \\X2\\ unicode hex sequences', () => {
    expect(decodeIfcString('\\X2\\00E4\\X0\\')).toBe('ä');
    expect(decodeIfcString('\\X2\\00E400FC\\X0\\')).toBe('äü');
  });

  it('decodes \\X4\\ 4-byte unicode sequences', () => {
    expect(decodeIfcString('\\X4\\0001D11E\\X0\\')).toBe('𝄞');
  });

  it('emits U+FFFD (no throw) for an \\X4\\ value above the Unicode max', () => {
    // 0x00110000 is one past the highest valid scalar (0x10FFFF). Previously
    // String.fromCodePoint threw a RangeError here, aborting the whole model
    // load on the columnar batch-name path.
    let out!: string;
    expect(() => { out = decodeIfcString('\\X4\\00110000\\X0\\'); }).not.toThrow();
    expect(out).toBe('�');
  });

  it('replaces only the offending scalar within a mixed \\X4\\ run', () => {
    // Valid 𝄞 (0x1D11E) followed by an out-of-range scalar -> valid char + FFFD.
    expect(decodeIfcString('\\X4\\0001D11EFFFFFFFF\\X0\\')).toBe('𝄞�');
  });

  it('accepts exactly 0x10FFFF (the highest valid scalar) in \\X4\\', () => {
    expect(decodeIfcString('\\X4\\0010FFFF\\X0\\')).toBe('\u{10FFFF}');
  });

  it('replaces surrogate values in \\X4\\ with U+FFFD (Rust char::from_u32 parity)', () => {
    // 0xD800 / 0xDFFF are surrogates, not Unicode scalar values; fromCodePoint
    // would happily produce an unpaired surrogate, but the Rust decoder emits
    // U+FFFD, and the two parse paths must agree byte-for-byte.
    expect(decodeIfcString('\\X4\\0000D800\\X0\\')).toBe('�');
    expect(decodeIfcString('\\X4\\0000DFFF\\X0\\')).toBe('�');
  });

  it('combines a surrogate pair split across \\X2\\ groups', () => {
    // D834 DD1E is the UTF-16 encoding of 𝄞 (0x1D11E).
    expect(decodeIfcString('\\X2\\D834DD1E\\X0\\')).toBe('𝄞');
  });

  it('replaces a lone surrogate in \\X2\\ with U+FFFD (from_utf16_lossy parity)', () => {
    expect(decodeIfcString('\\X2\\D800\\X0\\')).toBe('�');
    // High surrogate NOT followed by a low one, then a normal unit.
    expect(decodeIfcString('\\X2\\D8000041\\X0\\')).toBe('�A');
    // Low surrogate first (can never pair backwards).
    expect(decodeIfcString('\\X2\\DD1E0041\\X0\\')).toBe('�A');
  });

  it('passes malformed \\X2\\/\\X4\\ payloads through literally without throwing', () => {
    // Empty payload: the hex regex requires at least one digit.
    expect(decodeIfcString('\\X4\\\\X0\\')).toBe('\\X4\\\\X0\\');
    expect(decodeIfcString('\\X2\\\\X0\\')).toBe('\\X2\\\\X0\\');
    // Odd-length payloads (not a multiple of 8 / 4 hex digits).
    expect(decodeIfcString('\\X4\\0001D11\\X0\\')).toBe('\\X4\\0001D11\\X0\\');
    expect(decodeIfcString('\\X2\\00E\\X0\\')).toBe('\\X2\\00E\\X0\\');
    // Non-hex characters in the payload.
    expect(decodeIfcString('\\X4\\0001D11G\\X0\\')).toBe('\\X4\\0001D11G\\X0\\');
    // Unterminated directive (no \X0\ closer) stays literal.
    expect(decodeIfcString('\\X2\\00E4')).toBe('\\X2\\00E4');
    expect(decodeIfcString('\\X4\\0001D11E')).toBe('\\X4\\0001D11E');
  });

  it('decodes \\X\\ ISO-8859-1 single byte', () => {
    expect(decodeIfcString('\\X\\F1')).toBe('ñ');
  });

  it('passes a malformed \\X\\ payload through literally instead of decoding NaN as NUL', () => {
    // Non-hex digits: parseInt('ZZ', 16) is NaN, and String.fromCharCode(NaN)
    // silently produces U+0000 if the hex-format guard is ever removed.
    expect(decodeIfcString('\\X\\ZZ')).toBe('\\X\\ZZ');
    // Truncated payload (only one hex digit before the string ends).
    expect(decodeIfcString('\\X\\F')).toBe('\\X\\F');
    expect(decodeIfcString('\\X\\')).toBe('\\X\\');
  });

  it('decodes \\S\\ latin extended', () => {
    expect(decodeIfcString('\\S\\D')).toBe('Ä');
  });

  it('passes a truncated \\S\\ (no character following) through literally without throwing', () => {
    // If the "is there a char after \S\" boundary check is ever loosened by
    // one, str.codePointAt() reads past the end of the string (undefined),
    // undefined + 128 is NaN, and String.fromCodePoint(NaN) throws a
    // RangeError instead of leaving the unterminated escape as literal text.
    expect(() => decodeIfcString('\\S\\')).not.toThrow();
    expect(decodeIfcString('\\S\\')).toBe('\\S\\');
  });

  it('advances exactly one code unit past \\S\\ for a BMP codepoint at the 0xFFFF boundary', () => {
    // \S\X reads X as a whole code point so it can skip a surrogate pair when
    // X is astral, but U+FFFF itself is a single UTF-16 code unit (not a
    // surrogate) and must NOT be treated as a 2-unit pair. Trailing 'Y'
    // proves the offset: if the decoder over-advances by one unit here, 'Y'
    // is silently swallowed instead of appended.
    const input = `\\S\\${'￿'}Y`;
    const expected = `${String.fromCodePoint(0xFFFF + 128)}Y`;
    expect(decodeIfcString(input)).toBe(expected);
  });

  it('advances two code units past \\S\\ for an astral (non-BMP) codepoint', () => {
    // X = U+1D11E (𝄞, a surrogate pair): the decoder must skip both UTF-16
    // units of X, then continue with the trailing 'Y' marker.
    const input = `\\S\\${'\u{1D11E}'}Y`;
    const expected = `${String.fromCodePoint(0x1D11E + 128)}Y`;
    expect(decodeIfcString(input)).toBe(expected);
  });

  it('supports explicit \\PA\\ code page directive before \\S\\', () => {
    expect(decodeIfcString('\\PA\\\\S\\D')).toBe('Ä');
  });

  it('strips \\P code page switches in normal text', () => {
    expect(decodeIfcString('\\PA\\Hello')).toBe('Hello');
  });

  it('decodes mixed encodings in one string', () => {
    expect(decodeIfcString('Br\\X2\\00FC\\X0\\cke')).toBe('Brücke');
  });
});

describe('encodeIfcString', () => {
  it('keeps printable ASCII unchanged', () => {
    expect(encodeIfcString('Hello IFC')).toBe('Hello IFC');
  });

  it('encodes 8-bit latin chars as \\X\\HH', () => {
    expect(encodeIfcString('Ä')).toBe('\\X\\C4');
  });

  it('encodes BMP chars as \\X2\\....\\X0\\', () => {
    expect(encodeIfcString('Ω')).toBe('\\X2\\03A9\\X0\\');
  });

  it('encodes non-BMP chars as \\X4\\........\\X0\\', () => {
    expect(encodeIfcString('𝄞')).toBe('\\X4\\0001D11E\\X0\\');
  });

  it('round-trips with decoder for mixed characters', () => {
    const value = 'Brücke Ω 𝄞';
    expect(decodeIfcString(encodeIfcString(value))).toBe(value);
  });
});
