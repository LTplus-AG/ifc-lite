/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bundle integrity hashing.
 *
 * Uses SHA-256 via the platform WebCrypto API. Available on:
 *   - Node ≥ 15 (via globalThis.crypto.subtle)
 *   - All modern browsers
 *
 * Bundle hashes are stored in `InstalledExtensionRecord.bundleHash` and
 * verified on every load. A mismatch fails closed — the loader refuses
 * to activate a bundle whose bytes do not match the recorded hash.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §10 (signing
 * + supply chain). This is the local-only integrity check; Phase 5
 * adds Ed25519 signatures for the registry.
 */

const HEX = '0123456789abcdef';

/** Compute the SHA-256 hex digest of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so subarray views don't confuse the
  // WebCrypto implementation on some runtimes.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
}

/** Constant-time-ish equality for hex digests. */
export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    const byte = view[i];
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out;
}
