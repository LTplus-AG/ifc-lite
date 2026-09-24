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

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
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
    value = (value << 6) | BASE64_CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx] = (value >> bits) & 0xff;
      outIdx += 1;
    }
  }
  return out;
}
