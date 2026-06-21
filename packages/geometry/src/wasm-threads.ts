/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability probe for the threaded WASM bundle (`@ifc-lite/wasm/threaded`).
 *
 * Returns true only when the context can actually run it: cross-origin isolated
 * (so `SharedArrayBuffer` is enabled by the COOP/COEP headers) AND the engine
 * supports wasm threads/atomics. Safari, which lacks `credentialless` COEP, is
 * not cross-origin isolated and therefore correctly returns false → callers
 * fall back to the single-thread bundle. Synchronous; safe on both the main
 * thread and inside a worker.
 */
export function wasmThreadsSupported(): boolean {
  const g = globalThis as unknown as {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: unknown;
  };
  if (!g.crossOriginIsolated || typeof g.SharedArrayBuffer === 'undefined') return false;
  try {
    // wasm-feature-detect's canonical threads probe: a module declaring a SHARED
    // memory plus an atomic op. `WebAssembly.validate` returns true only when the
    // engine accepts threads/atomics — no instantiation, no side effects.
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1,
        9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
      ]),
    );
  } catch {
    return false;
  }
}

/**
 * Thread-pool size for the single-controller threaded bundle: most cores, less
 * one for the main thread + the parser, capped to keep dlmalloc's single lock
 * and memory bandwidth from dominating. `initThreadPool` is called with this.
 */
export function threadedPoolSize(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(cores - 1, 8));
}
