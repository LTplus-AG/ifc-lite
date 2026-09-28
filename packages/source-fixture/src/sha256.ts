/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A synchronous SHA-256, used only to compute `CommitArtifact.digest` from a
 * fixture commit's declared bytes.
 *
 * WHY NOT WebCrypto: `crypto.subtle.digest` is async, and the fixture builds
 * its whole world in `createFixtureSourceProvider`, which is synchronous and
 * must stay that way — every caller constructs one inline in a `describe`
 * body. Making the constructor async to compute a hash of a string literal
 * would push `await` into every fixture test in the repo.
 *
 * WHY NOT A DEPENDENCY: this package's one dependency is
 * `@ifc-lite/plugin-api`, which is itself dependency-free by contract. A test
 * oracle that drags in a hashing library is a test oracle whose failures can
 * come from the library.
 *
 * `sha256.test.ts` pins this against `crypto.subtle.digest` on real inputs,
 * so "the fixture's own hash" is never the thing under test.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = '0123456789abcdef';

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Padding: the message, a 0x80 byte, zeroes, then the bit length as a
  // big-endian 64-bit integer. `byteLength * 8` stays exact well past any
  // fixture's content, so the high word is always zero here — it is still
  // written, because a padding scheme that is only correct for small inputs
  // is a trap for whoever first declares a megabyte of fixture content.
  const bitLength = bytes.byteLength * 8;
  const paddedLength = ((bytes.byteLength + 9 + 63) >> 6) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(bytes);
  block[bytes.byteLength] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (const word of h) {
    for (let shift = 28; shift >= 0; shift -= 4) out += HEX[(word >>> shift) & 0xf];
  }
  return out;
}

/**
 * The `sha256:<hex>` spelling the commit contract uses for
 * `CommitArtifact.digest` — the same one `ModelIdentity.hash` in
 * `@ifc-lite/diff` already writes, which is what lets an identity sidecar pin
 * to a commit with no format change.
 */
export function artifactDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}
