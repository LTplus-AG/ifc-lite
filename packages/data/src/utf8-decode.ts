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
 *
 * Why the scratch is capped (#2183): "grows to the largest seen subarray"
 * is the right trade for the 50–500 byte reads this helper was written
 * for, but it makes a *single* whole-file decode permanent. A caller that
 * hands the entire source in (the viewer's grid / alignment / symbolic
 * overlay parses did exactly that) pushes the doubling scratch to the
 * next power of two above the file size and it is never released: a
 * 342 MB model pinned 512 MB for the lifetime of the realm, measured as
 * 30% of the whole main-thread heap. Reuse only pays off when a buffer is
 * hit repeatedly, which a one-off giant decode never is, so above
 * `MAX_RETAINED_SCRATCH_BYTES` we allocate a throwaway and let the GC
 * have it. The cap is far above every decode on the hot path, so those
 * callers keep the exact same reused buffer they had before.
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

/** Base capacity, and the unit every retained scratch size is a multiple of. */
const SCRATCH_BASE_BYTES = 4096;

/**
 * Largest scratch buffer kept alive between calls, in bytes.
 *
 * Must stay a power-of-two multiple of {@link SCRATCH_BASE_BYTES} so the
 * doubling loop below lands exactly on it and can never overshoot for a
 * request at or under the cap.
 *
 * 4 MiB is ~4 orders of magnitude above the 50–500 byte per-entity reads
 * this helper serves, so nothing on the hot path is pushed off the
 * retained buffer.
 */
const MAX_RETAINED_SCRATCH_BYTES = 4 * 1024 * 1024;

/**
 * Return a scratch `Uint8Array` of at least `byteLength` bytes.
 *
 * At or under {@link MAX_RETAINED_SCRATCH_BYTES} the realm-local buffer is
 * grown by doubling and reused. Above it the request is a one-off (see the
 * module header), so it gets a throwaway buffer that is not retained.
 */
function scratchFor(byteLength: number): Uint8Array {
  if (byteLength > MAX_RETAINED_SCRATCH_BYTES) {
    return new Uint8Array(byteLength);
  }
  if (scratchBuffer === null || scratchBuffer.length < byteLength) {
    let cap = scratchBuffer?.length ?? SCRATCH_BASE_BYTES;
    while (cap < byteLength) cap *= 2;
    scratchBuffer = new Uint8Array(cap);
  }
  return scratchBuffer;
}

/**
 * Bytes currently pinned by the retained scratch buffer. Tests only.
 * Deliberately not re-exported from the package index.
 */
export function __retainedScratchBytes(): number {
  return scratchBuffer?.length ?? 0;
}

/** Drop the retained scratch buffer. Tests only. */
export function __resetScratchBuffer(): void {
  scratchBuffer = null;
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
  const scratch = scratchFor(len);
  scratch.set(sub);
  return sharedDecoder.decode(scratch.subarray(0, len));
}
