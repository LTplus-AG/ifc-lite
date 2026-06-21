/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Type surface for the THREADED bundle (`@ifc-lite/wasm/threaded`).
//
// The threaded bundle's API is identical to the single-thread bundle plus
// wasm-bindgen-rayon's `initThreadPool`. Its runtime JS is built to
// `./pkg-threaded` by `scripts/build-wasm.sh` (BUILD_THREADED, on by default)
// and is gitignored like `./pkg`. This committed shim re-exports the plain
// type surface so `import('@ifc-lite/wasm/threaded')` type-resolves even on a
// host that hasn't built the threaded bundle (typecheck-only lanes), while the
// `import`/`default` export conditions point at the real built runtime.

export * from './pkg/ifc-lite.js';
export { default } from './pkg/ifc-lite.js';

/**
 * Initialize the wasm-bindgen-rayon thread pool. MUST be awaited after the wasm
 * module is initialized and before any rayon `par_iter` runs in this bundle.
 * Resolves once all worker threads have spun up.
 */
export function initThreadPool(numThreads: number): Promise<void>;
