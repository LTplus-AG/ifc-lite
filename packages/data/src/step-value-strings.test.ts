/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2490: `parseStepValue` un-doubled the
 * two ISO 10303-21 doublings with a directive-blind regex and stopped there, so
 * it never resolved a backslash DIRECTIVE and diverged from the shared decoder
 * on every non-ASCII value a real IFC file carries.
 *
 * The two halves of this file are the two halves of the contract, and both have
 * to hold at once — which is the reason the old regex could not simply grow a
 * `decodeIfcString` call after it:
 *
 *   - a literal from a REAL FILE now decodes its directives (the first block);
 *   - a value written by this module's own `escapeStepString` still comes back
 *     byte-identical (the second block). That writer emits non-ASCII RAW and
 *     never emits a directive, so every `\\` it produces really is a doubled
 *     reverse solidus — and giving directives precedence in the scan is exactly
 *     what keeps `\\X2\\…` reading as the LITERAL text `\X2\…` rather than
 *     decoding to the character it would have meant unescaped.
 *
 * Note how the fixtures are built. A source literal is spelled with explicit
 * `\\` in the TS string so the file says what bytes are on disk; the expected
 * value is spelled the same way. Getting that backwards is how a test of an
 * escaping function passes without testing anything.
 */

import { describe, it, expect } from 'vitest';
import { parseStepValue } from './step-serializers.js';
import { generateHeader } from './step-serializers.js';

/** Strip the outer quotes the way `parseStepValue` is handed a literal. */
const literal = (inner: string): string => `'${inner}'`;

describe('parseStepValue decodes STEP directives, not just the doublings', () => {
  it('resolves \\X2\\ to the character it encodes', () => {
    // The reported divergence: `@ifc-lite/data` returned the nine literal
    // characters where the shared decoder returns `ü`.
    expect(parseStepValue(literal('\\X2\\00FC\\X0\\'))).toBe('ü');
  });

  it('resolves a directive followed by an ESCAPED backslash', () => {
    // The case a two-pass "un-double, then decode" gets wrong: the doubling
    // pass eats the directive's own terminator and leaves `\X2\` dangling.
    expect(parseStepValue(literal('\\X2\\00FC\\X0\\\\\\'))).toBe('ü\\');
  });

  it('resolves the 8-bit, \\S\\ and code-page directives too', () => {
    expect(parseStepValue(literal('\\X\\E4'))).toBe('ä');
    expect(parseStepValue(literal('\\S\\d'))).toBe('ä');
    expect(parseStepValue(literal('\\PA\\abc'))).toBe('abc');
  });

  it('resolves \\X4\\ for a code point outside the BMP', () => {
    expect(parseStepValue(literal('\\X4\\0001F600\\X0\\'))).toBe('😀');
  });

  it('still un-doubles a quote', () => {
    expect(parseStepValue(literal("it''s"))).toBe("it's");
  });

  it('decodes directives inside a LIST, which is the other reachable path', () => {
    // `parseStepList` recurses into `parseStepValue`, so the list path had the
    // same gap and is the only in-repo caller.
    expect(parseStepValue("('\\X2\\00FC\\X0\\','plain')")).toEqual(['ü', 'plain']);
  });
});

describe('the escapeStepString / parseStepValue pair stays closed', () => {
  /** Round-trip a value through the writer this module ships and back. */
  const roundTrip = (value: string): unknown => {
    // `generateHeader` is the only public surface that runs `escapeStepString`
    // (it is not exported), and FILE_NAME's first argument is a plain string
    // literal — so this really is the writer, not a re-implementation of it.
    const header = generateHeader({ schema: 'IFC4', filename: value });
    const inner = /FILE_NAME\('((?:[^']|'')*)'/.exec(header)?.[1];
    expect(inner).toBeDefined();
    return parseStepValue(literal(inner!));
  };

  it('a Windows path survives', () => {
    expect(roundTrip('C:\\temp')).toBe('C:\\temp');
  });

  it('a UNC path survives', () => {
    expect(roundTrip('\\\\server\\share')).toBe('\\\\server\\share');
  });

  it('an apostrophe survives', () => {
    expect(roundTrip("it's")).toBe("it's");
  });

  it('a non-ASCII value survives - the writer emits it RAW', () => {
    // No directive is written, so nothing for the reader to decode; the point
    // is that the reader must not invent one.
    expect(roundTrip('Trümpler')).toBe('Trümpler');
  });

  it('text that LOOKS like a directive stays literal', () => {
    // The load-bearing case for the closed pair. The writer doubles the
    // backslashes, and the reader must read the doublings rather than the
    // directive they spell — otherwise a value round-trips into a different
    // character.
    expect(roundTrip('\\X2\\00FC\\X0\\')).toBe('\\X2\\00FC\\X0\\');
  });

  it('a directive-shaped value ending in a backslash stays literal', () => {
    expect(roundTrip('\\X2\\00FC\\X0\\\\')).toBe('\\X2\\00FC\\X0\\\\');
  });
});
