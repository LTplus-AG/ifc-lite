/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2323: the writer and the reader have to agree on BOTH ISO 10303-21
 * doublings, or fixing one half breaks the other.
 *
 * `escapeStepString` doubles the apostrophe and the reverse solidus on write;
 * the reader un-doubles the apostrophe at the tokenizer boundary and lets
 * `decodeIfcString` resolve the backslash pair. This pins the composition:
 * write then read must be the identity, and re-escaping an already-escaped
 * value must not accumulate (which is how a "read fix" turns into a value that
 * grows a backslash on every export).
 */

import { describe, it, expect } from 'vitest';
import { decodeIfcString } from '@ifc-lite/encoding';
import { escapeStepString } from './step-serialization.js';

const Q = '\u0027'; // apostrophe
const B = '\u005C'; // reverse solidus

/** The reader half: strip the literal's quotes, un-double, decode. */
function readStepLiteral(literal: string): string {
  expect(literal.startsWith(Q) && literal.endsWith(Q)).toBe(true);
  return decodeIfcString(literal.slice(1, -1).replace(/''/g, Q));
}

describe('STEP string escape round trip', () => {
  const values: Array<[string, string]> = [
    ['plain ascii', 'Wall 01'],
    ['one apostrophe', `O${Q}Brien`],
    ['one backslash', `C:${B}temp`],
    ['both', `a${Q}b${B}c`],
    ['two backslashes', `C:${B}${B}server`],
    ['two apostrophes', `${Q}${Q}`],
    ['trailing backslash', `end${B}`],
    ['leading backslash', `${B}start`],
    ['directive-shaped literal text', `${B}X2${B}00E9${B}X0${B}`],
    ['real non-ascii stays literal through the pair escapes', 'café'],
    ['backslash right before a directive-shaped run', `${B}${B}X2${B}`],
  ];

  for (const [name, value] of values) {
    it(`survives write then read: ${name}`, () => {
      expect(readStepLiteral(`${Q}${escapeStepString(value)}${Q}`)).toBe(value);
    });
  }

  it('is stable across a second export of the decoded value', () => {
    // Export -> import -> export must reproduce the same wire bytes. An
    // asymmetric pair (writer doubles, reader does not, or vice versa) shows up
    // here as a literal that grows or shrinks on every pass.
    for (const [, value] of values) {
      const once = escapeStepString(value);
      const twice = escapeStepString(readStepLiteral(`${Q}${once}${Q}`));
      expect(twice, `stable for ${JSON.stringify(value)}`).toBe(once);
    }
  });

  it('writes both doublings on the wire', () => {
    expect(escapeStepString(`O${Q}Brien`)).toBe(`O${Q}${Q}Brien`);
    expect(escapeStepString(`C:${B}temp`)).toBe(`C:${B}${B}temp`);
  });
});
