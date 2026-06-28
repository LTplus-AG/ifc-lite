/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Ambient types for the threaded WASM bundle (`@ifc-lite/wasm/threaded`). That
// bundle is built off-by-default (`BUILD_THREADED=1 ./scripts/build-wasm.sh`) and
// is therefore ABSENT from a fresh checkout / CI typecheck, which would otherwise
// fail `tsc` with TS2307 on `geometry.worker.ts`'s dynamic
// `import('@ifc-lite/wasm/threaded')`. The `./threaded` export deliberately omits
// a `types` condition so this ambient declaration is always the source of truth
// (no clash with the generated `.d.ts` when the bundle IS built locally). The
// worker casts the module to its own `ThreadedWasmGlue` shape, so only this
// minimal surface is needed. See docs/architecture/csg-threading-design.md.
declare module '@ifc-lite/wasm/threaded' {
  /** wasm-bindgen `--target web` default export: async instantiate. */
  export default function init(input?: unknown): Promise<unknown>;
  /** Synchronous instantiate from a compiled module (single-thread fallback). */
  export function initSync(input: { module_or_path: WebAssembly.Module }): unknown;
  /** wasm-bindgen-rayon: bring up the in-instance rayon thread pool. */
  export function initThreadPool(numThreads: number): Promise<unknown>;
  /** Same IfcAPI surface as the plain bundle (constructed, then cast). */
  export class IfcAPI {}
}
