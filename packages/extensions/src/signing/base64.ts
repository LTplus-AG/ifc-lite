/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tiny base64 codec that works in both Node (via Buffer) and browsers
 * (via atob/btoa). We avoid bringing in a dep for two-line wrappers.
 */

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Strict base64 — Node's Buffer.from silently ignores invalid chars,
// while atob throws. We validate first so behaviour is consistent and
// corrupted payloads don't decode quietly into garbage.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function fromBase64(b64: string): Uint8Array {
  if (typeof b64 !== 'string') {
    throw new Error('base64 payload must be a string');
  }
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new Error('Invalid base64 payload');
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) arr[i] = binary.charCodeAt(i);
  return arr;
}
