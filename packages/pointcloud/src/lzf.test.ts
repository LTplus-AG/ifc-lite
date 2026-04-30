/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { decompressLZF } from './lzf.js';

describe('decompressLZF', () => {
  it('decodes a single literal run', () => {
    // ctrl=0x02 means literal run of 3 bytes, followed by the bytes themselves
    const input = new Uint8Array([0x02, 0x41, 0x42, 0x43]);
    const out = decompressLZF(input, 3);
    expect(Array.from(out)).toEqual([0x41, 0x42, 0x43]);
  });

  it('decodes a back-reference', () => {
    // Literal "ABC" then back-reference: copy 3 bytes from offset -3.
    // ctrl byte for backref: top 3 bits = length-2 = 1 (so length=3),
    // bottom 5 bits = high byte of (offset-1) = 0; next byte = low byte of (offset-1) = 2
    //   -> ref = op - (0 << 8) - 2 - 1 = op - 3, length = 1+2 = 3
    const input = new Uint8Array([0x02, 0x41, 0x42, 0x43, 0x20, 0x02]);
    const out = decompressLZF(input, 6);
    expect(Array.from(out)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
  });

  it('throws when output overruns', () => {
    const input = new Uint8Array([0x02, 0x41, 0x42, 0x43]);
    expect(() => decompressLZF(input, 2)).toThrow();
  });

  it('throws when literal run is truncated', () => {
    const input = new Uint8Array([0x02, 0x41]);
    expect(() => decompressLZF(input, 3)).toThrow();
  });

  it('handles run-length expansion via overlapping back-reference', () => {
    // Literal 'A', then backref: length=4, offset=1 → fills with AAAAA.
    // top 3 bits length-2=2 → length 4; bottom 5 bits high(offset-1)=0; low byte=0 → ref=op-1
    const input = new Uint8Array([0x00, 0x41, 0x40, 0x00]);
    const out = decompressLZF(input, 5);
    expect(Array.from(out)).toEqual([0x41, 0x41, 0x41, 0x41, 0x41]);
  });
});
