/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SAB-safe wrapper around `TextDecoder.decode()`.
 *
 * Both Firefox and Chromium reject `TextDecoder.decode(view)` when `view`
 * is backed by a `SharedArrayBuffer` (Spectre timing-attack mitigation).
 * The parser intentionally hands the source bytes around as a SAB so the
 * parser worker, geometry workers, and main-thread on-demand extractors
 * all read the same memory zero-copy — which means every decode of a
 * subarray of the source needs to be SAB-aware.
 *
 * Strategy:
 *   1. Detect the runtime's SAB-decode policy lazily, once. The result is
 *      stable for the lifetime of the realm.
 *   2. When the runtime accepts SAB views, decode straight off the source
 *      (zero-copy, ~10 ns per call).
 *   3. When it rejects, copy the requested subarray into a thread-local
 *      scratch `Uint8Array` first, then decode. The scratch buffer grows
 *      to the largest seen subarray and is reused, so the GC pressure is
 *      bounded even for million-entity files.
 *
 * Performance: the typical IFC entity decode is 50–500 bytes, so the copy
 * path is microseconds per call. The hot batch decode path
 * (`columnar-parser-attributes.ts`) already routes through scratch
 * buffers, so only the per-entity attribute reads + schema detection +
 * tokenizer fallback go through this helper.
 */

const sharedDecoder = new TextDecoder();

let acceptsSabCache: boolean | null = null;

/**
 * Returns true when `TextDecoder.decode()` accepts a SAB-backed view in
 * this realm. Cached after first call.
 *
 * Exported so call sites can short-circuit explicit copies (e.g. when
 * they already know the view is SAB-backed and want to allocate a single
 * scratch buffer for a whole batch).
 */
export function textDecoderAcceptsSab(): boolean {
  if (acceptsSabCache !== null) return acceptsSabCache;
  if (typeof SharedArrayBuffer === 'undefined') {
    acceptsSabCache = true; // No SAB exists, so the question is moot.
    return true;
  }
  try {
    sharedDecoder.decode(new Uint8Array(new SharedArrayBuffer(8)));
    acceptsSabCache = true;
  } catch {
    acceptsSabCache = false;
  }
  return acceptsSabCache;
}

/**
 * Reset the detection cache. Tests only — production callers should never
 * need to invalidate the result because the answer is fixed for the
 * lifetime of the realm.
 */
export function __resetSabDecodeCache(): void {
  acceptsSabCache = null;
}

let scratchBuffer: Uint8Array | null = null;

/**
 * Ensure the realm-local scratch buffer can hold `byteLength` bytes,
 * doubling on growth to amortise reallocation cost.
 */
function ensureScratch(byteLength: number): Uint8Array {
  if (scratchBuffer === null || scratchBuffer.length < byteLength) {
    let cap = scratchBuffer?.length ?? 4096;
    while (cap < byteLength) cap *= 2;
    scratchBuffer = new Uint8Array(cap);
  }
  return scratchBuffer;
}

/**
 * Decode a UTF-8 byte range from `view` into a string. Safe to call on
 * `SharedArrayBuffer`-backed views in any realm.
 *
 * The optional `start`/`end` parameters mirror `Uint8Array.subarray`.
 * Calling without them decodes the entire view.
 */
export function safeUtf8Decode(view: Uint8Array, start?: number, end?: number): string {
  const sub = (start === undefined && end === undefined)
    ? view
    : view.subarray(start ?? 0, end ?? view.length);

  if (textDecoderAcceptsSab()) {
    return sharedDecoder.decode(sub);
  }

  // SAB rejected — copy into scratch. `Uint8Array.set` accepts SAB-backed
  // sources without restriction (the Spectre mitigation only fires inside
  // string-producing APIs like TextDecoder), so this gives us an
  // ArrayBuffer-backed view with the same bytes.
  const len = sub.length;
  if (len === 0) return '';
  const scratch = ensureScratch(len);
  scratch.set(sub);
  return sharedDecoder.decode(scratch.subarray(0, len));
}
