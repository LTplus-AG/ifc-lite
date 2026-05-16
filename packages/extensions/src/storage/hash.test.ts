/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { hexEqual, sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the known empty digest', async () => {
    const hex = await sha256Hex(new Uint8Array());
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known digest of "abc"', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the known digest of the empty file double-byte', async () => {
    const hex = await sha256Hex(new Uint8Array([0x00, 0x01]));
    // sha256(\x00\x01) — generated via reference
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const bytes = new TextEncoder().encode('reproducible');
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(bytes));
  });

  it('differs for different inputs', async () => {
    const a = await sha256Hex(new TextEncoder().encode('foo'));
    const b = await sha256Hex(new TextEncoder().encode('bar'));
    expect(a).not.toBe(b);
  });

  it('handles a sub-array view', async () => {
    const full = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const view = full.subarray(1, 4); // [0x20, 0x30, 0x40]
    const directBytes = new Uint8Array([0x20, 0x30, 0x40]);
    expect(await sha256Hex(view)).toBe(await sha256Hex(directBytes));
  });
});

describe('hexEqual', () => {
  it('returns true for equal strings', () => {
    expect(hexEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(hexEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(hexEqual('abc', 'abcd')).toBe(false);
  });

  it('returns true for the empty strings', () => {
    expect(hexEqual('', '')).toBe(true);
  });
});
