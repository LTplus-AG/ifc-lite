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
    // Empty payload: the hex regex requires at least one digit, so the leading
    // `\X4\` is not a directive. What is left IS a doubled reverse solidus
    // (`\X4` + `\\` + `X0` + a dangling `\`), so the pair collapses to one
    // backslash (#2323). Before that arm existed both backslashes survived.
    expect(decodeIfcString('\\X4\\\\X0\\')).toBe('\\X4\\X0\\');
    expect(decodeIfcString('\\X2\\\\X0\\')).toBe('\\X2\\X0\\');
    // Odd-length payloads (not a multiple of 8 / 4 hex digits).
    expect(decodeIfcString('\\X4\\0001D11\\X0\\')).toBe('\\X4\\0001D11\\X0\\');
    expect(decodeIfcString('\\X2\\00E\\X0\\')).toBe('\\X2\\00E\\X0\\');
    // Non-hex characters in the payload.
    expect(decodeIfcString('\\X4\\0001D11G\\X0\\')).toBe('\\X4\\0001D11G\\X0\\');
    // Unterminated directive (no \X0\ closer) stays literal.
    expect(decodeIfcString('\\X2\\00E4')).toBe('\\X2\\00E4');
    expect(decodeIfcString('\\X4\\0001D11E')).toBe('\\X4\\0001D11E');
  });

  it('collapses the doubled reverse solidus to one backslash', () => {
    // ISO 10303-21 doubles `\` inside a string literal exactly as it doubles
    // `'`, so `C:\\temp` in the file is the value `C:\temp` (#2323).
    expect(decodeIfcString('C:\\\\temp')).toBe('C:\\temp');
    expect(decodeIfcString('\\\\')).toBe('\\');
    expect(decodeIfcString('\\\\\\\\')).toBe('\\\\');
  });

  it('gives a directive precedence over the doubled-backslash pair', () => {
    // A directive immediately followed by an escaped backslash ends in THREE
    // backslashes. The directive must consume its own `\X0\` terminator first;
    // a pre-pass that collapsed pairs left-to-right would eat the terminator.
    expect(decodeIfcString('\\X2\\00FC\\X0\\\\\\')).toBe('\u00fc\\');
    // The mirror case: an ESCAPED backslash followed by the literal text
    // `X2\00FC\X0\` is not a directive at all.
    expect(decodeIfcString('\\\\X2\\00FC\\X0\\')).toBe('\\X2\\00FC\\X0\\');
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

  it('maps \\S\\ through a non-default \\P?\\ code page instead of hardcoding ISO 8859-1 (ISO 10303-21 6.4.3)', () => {
    // \PE\ selects ISO 8859-5 (Cyrillic). 0x50('P')+128=0xD0, which is
    // U+0430 (CYRILLIC SMALL LETTER A) in ISO 8859-5, not U+00D0 (LATIN
    // CAPITAL LETTER ETH) the default page gives for the same byte.
    expect(decodeIfcString('\\PE\\\\S\\P')).toBe('а');
    // The selected page persists across every \S\ in the string, not just
    // the next one, until another \P?\ directive switches it.
    expect(decodeIfcString('\\PE\\\\S\\P\\S\\Q')).toBe('аб');
    expect(decodeIfcString('\\PE\\\\S\\P\\PA\\\\S\\P')).toBe('аÐ');
  });

  it('falls back to the raw byte for a code position the selected page leaves unassigned', () => {
    // ISO 8859-6 (Arabic, \PF\) leaves byte 0xB0 unassigned. ISO 10303-21
    // does not define decoder behaviour there; this decoder answers with the
    // raw code point (identity, same as the default page) rather than U+FFFD.
    expect(decodeIfcString('\\PF\\\\S\\0')).toBe('°');
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

  it('encodes a literal reverse solidus as \\X\\5C instead of passing it through raw', () => {
    // A raw backslash falls inside the printable-ASCII range (32-126), so the
    // range check alone would keep it as-is. But an unescaped '\' in the
    // output is exactly what a STEP reader (see step-string-literal.ts's
    // "writer's half of the contract") would misread as the start of a
    // directive or an unterminated pair — the encoder must route it through
    // the \X\HH directive form instead, same as any other 8-bit value.
    expect(encodeIfcString('\\')).toBe('\\X\\5C');
    expect(decodeIfcString(encodeIfcString('\\'))).toBe('\\');
  });

  it('does NOT double the apostrophe (pins current behaviour, issue #3445)', () => {
    // The apostrophe is code point 39, printable ASCII, so unlike the raw
    // backslash above it passes straight through the range check untouched.
    // The comment on the reverse-solidus test just above makes exactly the
    // argument that transfers here: an unescaped `'` in output destined for a
    // STEP literal terminates the literal early (`O'Brien` -> `'O'Brien'`).
    // But that argument does NOT make this a bug in isolation, because
    // `encodeIfcString` never claimed to be literal-safe once its doc is
    // corrected — only that it emits directive escapes. Whether apostrophe
    // doubling belongs here or in the caller (`escapeStepString` in
    // `@ifc-lite/data` already does it) is an open question for #3445, not
    // decided by this repo yet. This test pins TODAY'S behaviour so any
    // change is a deliberate decision, not a silent one — it is not an
    // assertion that the behaviour is correct.
    expect(encodeIfcString("'")).toBe("'");
    expect(encodeIfcString("O'Brien")).toBe("O'Brien");
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
