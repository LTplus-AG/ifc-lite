/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Asserts the wasm-URL plumbing surface for #666 follow-up: consumers
 * whose bundler can't transform `new URL('ifc-lite_bg.wasm', import.meta.url)`
 * inside the worker (or who serve the wasm from a different origin) must
 * be able to override it via `ProcessParallelOptions.wasmUrls`.
 *
 * These are surface-level type/shape checks; the integration path is
 * verified via the geometry-processor-streaming tests (which exercise
 * the worker codepath end-to-end against the actual wasm bundle).
 */

import { describe, it, expect } from 'vitest';
import type { ProcessParallelOptions } from './geometry-parallel.js';
import type { GeometryWorkerInitMessage } from './geometry.worker.js';

describe('#666 wasm-url plumbing', () => {
  it('GeometryWorkerInitMessage accepts an optional wasmUrl', () => {
    // The type assertion below is the actual test: if `wasmUrl` is
    // dropped from the message contract, this file fails to typecheck.
    const msg: GeometryWorkerInitMessage = {
      type: 'init',
      wasmUrl: 'https://cdn.example.com/ifc-lite_bg.wasm',
    };
    expect(msg.type).toBe('init');
    expect(msg.wasmUrl).toBe('https://cdn.example.com/ifc-lite_bg.wasm');
  });

  it('ProcessParallelOptions exposes wasmUrls for both bundles', () => {
    // Same idea: if either key is renamed or dropped, the file fails
    // to typecheck. Both legacy + threaded bundles must be configurable
    // because `processParallel` picks one based on `useSingleController`.
    const opts: ProcessParallelOptions = {
      wasmUrls: {
        wasm: '/assets/ifc-lite_bg.wasm',
        wasmThreaded: '/assets/ifc-lite-threaded_bg.wasm',
      },
    };
    expect(opts.wasmUrls?.wasm).toBe('/assets/ifc-lite_bg.wasm');
    expect(opts.wasmUrls?.wasmThreaded).toBe('/assets/ifc-lite-threaded_bg.wasm');
  });

  it('wasmUrls is optional — default Vite/webpack consumers omit it', () => {
    // Critical: passing no wasmUrls must remain valid. Vite/webpack
    // consumers rely on wasm-bindgen's `import.meta.url`-based default
    // resolution; forcing them to provide URLs would break the
    // existing zero-config experience.
    const opts: ProcessParallelOptions = {};
    expect(opts.wasmUrls).toBeUndefined();
  });
});
