/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProcessParallelOptions } from './geometry-parallel-options.js';

/**
 * The per-load configuration every process worker receives before any stream
 * message: wasm init plus the load-time toggles. Shared by the initial pool and
 * by a worker replaced after a hung geometry call (#4884), which must be
 * configured identically or its meshes would differ from its siblings'.
 */
export function postGeometryWorkerInit(
  worker: Worker,
  options: ProcessParallelOptions | undefined,
  sharedWasmModule: WebAssembly.Module | null,
): void {
  // Instantiate WASM. When the host compiled the module once (`compileSharedWasmModule`), each
  // worker `initSync`s it (cheap); otherwise it falls back to compiling from
  // bytes. The worker's tail-promise serialiser guarantees this `init`
  // completes before any subsequent `stream-start`/`stream-chunk` runs.
  //
  // `wasmUrl` is forwarded only when the consumer explicitly provided one AND
  // no shared module is available — undefined leaves the worker on
  // wasm-bindgen's default `import.meta.url`-based resolution (Vite + webpack).
  const wasmUrlForWorker = options?.wasmUrls?.wasm;
  worker.postMessage(
    {
      type: 'init',
      ...(sharedWasmModule
        ? { wasmModule: sharedWasmModule }
        : wasmUrlForWorker
          ? { wasmUrl: wasmUrlForWorker }
          : {}),
    },
  );
  // Issue #540: forward the user's "Merge Multilayer Walls" toggle
  // BEFORE any stream-start so the worker's IfcAPI has the flag set
  // before its first parse call. The tail-promise serialiser inside
  // each worker preserves this order even though the messages are
  // posted back-to-back. We always send the message so the controller
  // path doesn't have to remember whether the host called it — the
  // default `false` is a cheap no-op.
  worker.postMessage({
    type: 'set-merge-layers',
    enabled: options?.mergeLayers === true,
  });
  // GPU-instancing partition toggle — default ON; the host sets false for federated
  // loads so a federated model's geometry stays flat (instancing is primary-only).
  worker.postMessage({
    type: 'set-instancing-enabled',
    enabled: options?.enableInstancing !== false,
  });
  // Issue #924: forward the geometry-hash tolerance the same way — always
  // sent so the controller path stays uniform; null is a cheap no-op.
  worker.postMessage({
    type: 'set-compute-geometry-hashes',
    tolerance: options?.geometryHashTolerance ?? null,
  });
  // Issue #976: forward the tessellation-quality level the same way —
  // null keeps the Rust default (Medium / historical densities).
  worker.postMessage({
    type: 'set-tessellation-quality',
    level: options?.tessellationQuality ?? null,
  });
  // Issue #1286: forward the small-cut skip the same way — always sent so a
  // worker reused by a later export (which omits it) resets to false.
  worker.postMessage({
    type: 'set-skip-small-cuts',
    enabled: options?.skipSmallCuts === true,
  });
}
