/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { perfTally } from '@ifc-lite/load-trace';

/**
 * TRUE full-file content hash of a source (distinct from the O(1) spread
 * fingerprint in `@ifc-lite/cache`'s `source-fingerprint.ts`, which only keys a
 * cache entry and cannot see bytes between its sample windows). A model LOAD
 * does not call this: its one full-source pass is the chunked placement
 * identity (`lib/model-placement/source-identity.ts`), which the cache write
 * and warm-hit revalidation reuse (#7022). Each call counts as one
 * `hash.fullSource` pass in the load-trace counters.
 *
 * Uses the Web Crypto `crypto.subtle.digest('SHA-256', …)`, which is:
 *   - asynchronous and implemented natively OFF the JS main thread (no worker
 *     file, no message-passing), so hashing a 300MB+ source never janks the UI;
 *   - zero-copy for a normal `ArrayBuffer` (the digest reads the buffer in
 *     place). A `SharedArrayBuffer`-backed view is rejected by SubtleCrypto for
 *     data-race safety, so it is copied to a plain buffer first.
 *
 * Returns `null` when Web Crypto is unavailable (e.g. an insecure-context / very
 * old browser); callers treat that as "no content identity".
 */
export async function computeFullSourceHash(
  source: ArrayBufferLike | ArrayBufferView,
): Promise<string | null> {
  perfTally('hash.fullSource', source.byteLength); // #7022: one full pass over a source
  return sha256Hex(source);
}

/** SHA-256 hex of `source` WITHOUT counting a full-source pass: for a caller
 *  that hashes one piece of a pass and counts the pass itself
 *  (`placementSourceIdentity`'s chunks). Same contract as above. */
export async function sha256Hex(
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

/**
 * {@link computeFullSourceHash} from a `Blob`/`File` handle rather than an
 * already-loaded buffer — for a caller (e.g. `lib/compare/identitySidecar.ts`) that
 * only holds `FederatedModel.sourceFile` and needs a TRUE full-content
 * identity, not the O(1) spread sampler in `@ifc-lite/cache`'s `source-fingerprint.ts` (that
 * sampler is a cache-lookup key backed by an mtime guard and this same
 * full-hash as its OWN revalidation layer elsewhere; used bare as an identity
 * key it has a provable blind spot — see `@ifc-lite/cache`'s `source-fingerprint.ts`'s docs and
 * `sourceContentHash.test.ts`'s gap-edit tests). Reads the whole blob into
 * memory via `Blob.arrayBuffer()`; unlike the sampler this is O(file size),
 * which is the unavoidable cost of an identity that cannot be fooled by an
 * edit landing between sample windows.
 */
export async function computeFullSourceHashFromBlob(blob: Blob): Promise<string | null> {
  const buf = await blob.arrayBuffer();
  return computeFullSourceHash(buf);
}
