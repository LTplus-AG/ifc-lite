/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { trimSelectorWhitespace } from './tokenize.js';

describe('trimSelectorWhitespace', () => {
  it('trims exactly the six characters the tokenizer treats as whitespace', () => {
    expect(trimSelectorWhitespace(' \t\nIfcWall\r\f\v')).toBe('IfcWall');
    expect(trimSelectorWhitespace('IfcWall')).toBe('IfcWall');
    expect(trimSelectorWhitespace('   ')).toBe('');
    expect(trimSelectorWhitespace('')).toBe('');
  });

  it('keeps U+00A0 (no-break space), which String.trim() would strip but the tokenizer reads as ordinary word content (#4946 review)', () => {
    const nbsp = ' ';
    expect(trimSelectorWhitespace(`${nbsp}IfcWall${nbsp}`)).toBe(`${nbsp}IfcWall${nbsp}`);
    expect(`${nbsp}IfcWall${nbsp}`.trim()).toBe('IfcWall'); // the behaviour this helper deliberately does not have
  });
});
