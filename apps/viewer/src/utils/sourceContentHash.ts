/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TRUE full-file content hash of an IFC source, used to VALIDATE a mesh-only
 * cache hit (distinct from the O(1) spread fingerprint in `sourceFingerprint.ts`,
 * which only keys the entry and cannot see bytes between its sample windows).
 *
 * Uses the Web Crypto `crypto.subtle.digest('SHA-256', …)`, which is:
 *   - asynchronous and implemented natively OFF the JS main thread (no worker
 *     file, no message-passing), so hashing a 300MB+ source never janks the UI;
 *   - zero-copy for a normal `ArrayBuffer` (the digest reads the buffer in
 *     place). A `SharedArrayBuffer`-backed view is rejected by SubtleCrypto for
 *     data-race safety, so it is copied to a plain buffer first — that only
 *     happens for the ≥256MB SAB-streaming band, and only on the backgrounded
 *     write / background revalidation, never on the interactive path.
 *
 * Returns `null` when Web Crypto is unavailable (e.g. an insecure-context / very
 * old browser). Callers treat `null` as "cannot revalidate": combined with the
 * mtime guard, a hit is only served when mtime confirms it OR a full hash is
 * available to revalidate — never served fully unvalidated.
 */
export async function computeFullSourceHash(
  source: ArrayBufferLike | ArrayBufferView,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) return null; // insecure context / unavailable

  try {
    // Normalize to a Uint8Array view over the source bytes (zero copy).
    const u8: Uint8Array = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
    const raw = u8.buffer;

    // SubtleCrypto only accepts ArrayBuffer-backed data (a SharedArrayBuffer view
    // is rejected for data-race safety). A plain ArrayBuffer is hashed in place
    // (zero copy); a SAB (only the ≥256MB SAB-streaming band) is copied first.
    const bytes: Uint8Array<ArrayBuffer> = raw instanceof ArrayBuffer
      ? new Uint8Array(raw, u8.byteOffset, u8.byteLength)
      : Uint8Array.from(u8);

    const digest = await subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  } catch (err) {
    // Never let a hashing failure break a load — treat as "cannot revalidate".
    console.warn('[source-hash] full-file hash failed; skipping revalidation', err);
    return null;
  }
}

const HEX = '0123456789abcdef';
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}
