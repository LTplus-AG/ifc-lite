/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runtime feature detection for the threaded WASM geometry bundle
// (`@ifc-lite/wasm` `pkg-threaded`, built off-by-default via `BUILD_THREADED=1`).
// Using it requires TWO gates, both checked here:
//   1. the engine supports the WASM threads proposal (shared memory), and
//   2. the page is cross-origin isolated, so SharedArrayBuffer is available.
// Safari lacks credentialless cross-origin isolation, so it fails gate 2 and
// loads the single-thread bundle. See docs/architecture/csg-threading-design.md.

// Minimal module `(module (memory 1 1 shared))`. Shared memory is part of the
// threads proposal, so `WebAssembly.validate()` returns true only on engines
// that support it. 14 bytes, generated with `wasm-tools parse`.
const THREADS_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 3, 1, 1]);

let threadsCache: boolean | undefined;

/** True if the WASM engine supports the threads proposal (shared memory). */
export function supportsWasmThreads(): boolean {
  if (threadsCache === undefined) {
    try {
      threadsCache =
        typeof WebAssembly !== 'undefined' &&
        typeof WebAssembly.validate === 'function' &&
        WebAssembly.validate(THREADS_PROBE);
    } catch {
      threadsCache = false;
    }
  }
  return threadsCache;
}

/**
 * True if the threaded geometry bundle can actually run in this context: the
 * engine supports threads AND the page is cross-origin isolated (required for
 * `SharedArrayBuffer`). This is the gate the two-bundle runtime selection uses
 * to choose `pkg-threaded` over `pkg`; when false, callers fall back to the
 * single-thread bundle and the existing N-worker pool.
 */
export function isThreadedWasmUsable(): boolean {
  return (
    supportsWasmThreads() &&
    typeof globalThis !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}
