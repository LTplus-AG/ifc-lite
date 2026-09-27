/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base64 without `Buffer` or `btoa`/`atob`: this package runs in the browser
 * (`viewer-embed`) as well as headlessly, and neither global is guaranteed —
 * `Buffer` needs a bundler polyfill most Vite configs do not add, and `atob`
 * mangles bytes above 0x7F on some hosts' string-vs-binary handling. A tiny
 * table-driven codec sidesteps both.
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) table[BASE64_CHARS.charCodeAt(i)] = i;
  return table;
})();
const PAD = 0x3d; // '='

/**
 * Encode into one preallocated ASCII buffer and decode it once. Appending
 * four characters per 3 bytes built hundreds of millions of intermediate
 * strings for a large download (#5935 review).
 */
export function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out[o++] = BASE64_CHARS.charCodeAt(b0 >> 2);
    out[o++] = BASE64_CHARS.charCodeAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out[o++] = has1 ? BASE64_CHARS.charCodeAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : PAD;
    out[o++] = has2 ? BASE64_CHARS.charCodeAt(b2 & 0x3f) : PAD;
  }
  return new TextDecoder('ascii').decode(out);
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.endsWith('==') ? clean.length - 2 : clean.endsWith('=') ? clean.length - 1 : clean.length;
  const byteLength = Math.floor((len * 6) / 8);
  const out = new Uint8Array(byteLength);
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (let i = 0; i < len; i += 1) {
    value = ((value << 6) | DECODE[clean.charCodeAt(i)]) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx] = (value >> bits) & 0xff;
      outIdx += 1;
    }
  }
  return out;
}
