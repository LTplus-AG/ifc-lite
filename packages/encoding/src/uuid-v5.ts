/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Name-based UUIDs, version 5 (RFC 9562 §5.5).
 *
 * Unlike {@link uuidFromSeed} (an ifc-lite-internal hash scheme), a v5 UUID is
 * the standard, interoperable way to derive an identifier from a namespace +
 * name: any conforming implementation, in any language, computes the same
 * UUID. The viewer derives the GlobalId of the new piece of a split element
 * this way (#6233), so the same split yields the same id everywhere.
 */

import { isValidUuid } from './guid.js';

/**
 * SHA-1 of `bytes`, synchronously. Only for name-based UUIDs, which fix SHA-1
 * as their hash; it is NOT a security primitive here. Web Crypto's digest is
 * async, and {@link uuidV5} is called inside synchronous edits.
 */
function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
          : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
            : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}

/**
 * Name-based UUID, version 5: the same `namespace` + `name` always yields the
 * same lowercase 8-4-4-4-12 UUID. Compose with `uuidToIfcGuid` for a
 * deterministic IFC GlobalId.
 */
export function uuidV5(namespace: string, name: string): string {
  if (!isValidUuid(namespace)) throw new Error(`Invalid namespace UUID: ${namespace}`);
  const ns = namespace.replace(/-/g, '');
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(ns.substring(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const bytes = sha1(input).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}
