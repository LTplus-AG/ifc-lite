/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { escapeStepString, parseStepValue, serializeValue } from './step-serializers.js';

describe('canonical printable ASCII STEP strings #7363', () => {
  it('preserves every basic graphic byte with STEP quote and reverse-solidus escaping', () => {
    const input = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');
    const expected = ' !"#$%&\'\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    expect(escapeStepString(input)).toBe(expected);
    expect(parseStepValue(serializeValue(input))).toBe(input);
    expect(escapeStepString('')).toBe('');
  });

  it('keeps a complete two-million-character native Group Name byte-identical', () => {
    const plain = 'x'.repeat(2_000_000);
    expect(escapeStepString(plain)).toBe(plain);
    const input = `${plain}'\\`;
    expect(escapeStepString(input)).toBe(`${plain}''\\\\`);
    expect(parseStepValue(serializeValue(input))).toBe(input);
  });

  for (const [input, expected] of [
    ['ASCII\nASCII', 'ASCII\\X2\\000A\\X0\\ASCII'],
    ['ASCII\u007fASCII', 'ASCII\\X2\\007F\\X0\\ASCII'],
    ['ASCIIéASCII', 'ASCII\\X2\\00E9\\X0\\ASCII'],
    ['ASCII😀ASCII', 'ASCII\\X4\\0001F600\\X0\\ASCII'],
    ["'\\é\n😀", "''\\\\\\X2\\00E9\\X0\\\\X2\\000A\\X0\\\\X4\\0001F600\\X0\\"],
  ]) {
    it(`preserves directive encoding and roundtrip for ${JSON.stringify(input)}`, () => {
      expect(escapeStepString(input)).toBe(expected);
      expect(parseStepValue(serializeValue(input))).toBe(input);
    });
  }
});
