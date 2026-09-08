/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The contract of `decodeStepStringLiteral`, hoisted out of
 * `packages/parser/src/source-header.ts` for #2490 once `@ifc-lite/data`'s
 * `parseStepValue` turned out to have grown the same directive-blind regex
 * independently.
 *
 * The cases that matter are the ones where the two escape LAYERS interact —
 * a doubling that abuts a directive, and text that merely looks like a
 * directive. Each has a wrong answer that a single-layer reader gives happily.
 */

import { describe, it, expect } from 'vitest';
import { decodeStepStringLiteral } from './step-string-literal.js';

describe('decodeStepStringLiteral', () => {
  it('resolves each directive form', () => {
    expect(decodeStepStringLiteral('\\X2\\00FC\\X0\\')).toBe('ü');
    expect(decodeStepStringLiteral('\\X4\\0001F600\\X0\\')).toBe('😀');
    expect(decodeStepStringLiteral('\\X\\E4')).toBe('ä');
    expect(decodeStepStringLiteral('\\S\\d')).toBe('ä');
    expect(decodeStepStringLiteral('\\PA\\abc')).toBe('abc');
  });

  it('un-doubles both lexical doublings', () => {
    expect(decodeStepStringLiteral("it''s")).toBe("it's");
    expect(decodeStepStringLiteral('C:\\\\temp')).toBe('C:\\temp');
    expect(decodeStepStringLiteral('\\\\\\\\server\\\\share')).toBe('\\\\server\\share');
  });

  it('keeps a directive whole when an escaped backslash follows it', () => {
    // Three backslashes in a row: the directive's terminator, then the pair.
    // A doubling pass run FIRST eats the first two and leaves `\X2\` dangling.
    expect(decodeStepStringLiteral('\\X2\\00FC\\X0\\\\\\')).toBe('ü\\');
  });

  it('keeps ESCAPED directive text literal', () => {
    // `\\X2\\00FC\\X0\\` means the nine characters `\X2\00FC\X0\`. Decoding it
    // to `ü` would turn a value into a different value on every round trip.
    expect(decodeStepStringLiteral('\\\\X2\\\\00FC\\\\X0\\\\')).toBe('\\X2\\00FC\\X0\\');
  });

  it('leaves plain text and raw non-ASCII alone', () => {
    expect(decodeStepStringLiteral('Trümpler')).toBe('Trümpler');
    expect(decodeStepStringLiteral('')).toBe('');
  });

  it('preserves an unterminated directive rather than dropping it', () => {
    // `decodeIfcString` keeps an unknown escape; a truncated `\X2\` has no
    // `\X0\` to close it, and losing the payload would be silent data loss.
    expect(decodeStepStringLiteral('\\X2\\00FC')).toBe('\\X2\\00FC');
  });
});
