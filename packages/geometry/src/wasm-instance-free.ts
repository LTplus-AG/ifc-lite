/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dropping a wasm-bindgen wrapper on the geometry worker's error-recovery path.
 *
 * The recovery in `processBatch` abandons the engine instance that just failed
 * and lets `ensureInit` install a fresh one. It calls `free()` first because the
 * abandoned instance holds a file-sized source copy (`setSourceBytes`), so
 * waiting for GC would transiently double the source in this worker's
 * never-shrinking wasm heap — on exactly the memory-stressed models that trigger
 * recovery in the first place.
 *
 * `free()` can legitimately throw: wasm-bindgen raises on a wrapper whose
 * pointer is already null, and every call into an instance that trapped raises
 * too — which is the common case here, because a trap is what we are recovering
 * from. A throw therefore means the block was NOT returned to the wasm allocator
 * and the very pressure `free()` exists to avoid is present but invisible.
 */

let freeFailureLogged = false;

/**
 * Free `instance`, tolerating a wrapper that is already invalid.
 *
 * Logged **once per module instance** — i.e. once per worker. The callers are
 * the per-entity and per-batch recovery paths, which one bad model can drive
 * thousands of times in a single load; a per-occurrence line there is a flood,
 * not diagnostics.
 */
export function freeWasmInstanceQuietly(instance: { free: () => void } | null | undefined): void {
  try {
    instance?.free();
  } catch (err) {
    if (freeFailureLogged) return;
    freeFailureLogged = true;
    console.warn(
      '[Worker] Freeing the failed engine instance threw, so its file-sized source copy stays ' +
        'in the wasm heap until GC (logged once per worker):',
      err,
    );
  }
}
