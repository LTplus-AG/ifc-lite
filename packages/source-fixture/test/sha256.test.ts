/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fixture is the oracle every provider's conformance run is measured
 * against, so its own hash must be measured against something else. Here that
 * is the platform's WebCrypto, plus the two published FIPS-180-4 vectors —
 * the empty string and `"abc"` — which pin the implementation even on a
 * runtime whose `crypto.subtle` is missing.
 */

import { describe, expect, it } from 'vitest';

import { artifactDigest, sha256Hex } from '../src/sha256.js';

async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256Hex', () => {
  it('matches the published FIPS-180-4 vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches WebCrypto across the block-boundary sizes padding gets wrong', () => {
    // 55/56/57 straddle the one-block cutoff (a 64-byte block minus the
    // 8-byte length field minus the 0x80 byte), and 63/64/65 the next one.
    // A padding bug that only shows at a boundary is the classic way a
    // hand-written SHA-256 passes the short vectors and still ships broken.
    const sizes = [1, 54, 55, 56, 57, 63, 64, 65, 119, 128, 1000];
    return Promise.all(
      sizes.map(async (size) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
        expect(sha256Hex(bytes), `size ${size}`).toBe(await webCryptoHex(bytes));
      }),
    );
  });

  it('artifactDigest carries the algorithm prefix the commit contract requires', () => {
    const digest = artifactDigest(new TextEncoder().encode('abc'));
    expect(digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
