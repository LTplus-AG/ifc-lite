/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64.js';

describe('base64 codec', () => {
  it('round-trips every padding case and matches the platform encoding', () => {
    for (let n = 0; n <= 10; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 255 - n) & 0xff);
      const text = toBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(fromBase64(text))).toEqual(Array.from(bytes));
    }
  });

  it('encodes a multi-megabyte buffer without building it one character at a time', () => {
    const bytes = new Uint8Array(8 * 1024 * 1024).map((_, i) => i & 0xff);
    const text = toBase64(bytes);
    expect(text.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(text).toBe(Buffer.from(bytes).toString('base64'));
  });
});
