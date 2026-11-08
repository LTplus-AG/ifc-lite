/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The geometry-core engine (`@ifc-lite/wasm/core`, aliased in for
// `@ifc-lite/wasm`) exports the URL of its own binary. The shared compile must
// fetch THAT binary: the core glue's import object does not link against the
// full engine the default sibling path names, so handing it the full module
// would fail at instantiation (and download the 10 MB engine it replaced).
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above every declaration, so the URL comes through vi.hoisted.
const { CORE_BINARY } = vi.hoisted(() => ({ CORE_BINARY: 'https://course.test/assets/ifc-lite_bg-core.wasm' }));
vi.mock('@ifc-lite/wasm', () => ({
  ENGINE_BINARY_URL: new URL(CORE_BINARY),
  default: async () => undefined,
}));

import { compileSharedWasmModule, prepareSharedWasmInit } from './wasm-shared-module.js';

// () -> i32 `answer`, a real executable module (no IFC engine needed).
const answerBytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 7, 11,
]);

describe('shared wasm module under the geometry-core engine', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('compiles the binary the aliased glue names, not the full sibling engine', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(answerBytes, { headers: { 'Content-Type': 'application/wasm' } });
    });
    const module = await compileSharedWasmModule();
    expect(module).toBeInstanceOf(WebAssembly.Module);
    expect(requested).toEqual([CORE_BINARY]);
    if (!module) throw new Error('no shared module');
    const { exports } = await WebAssembly.instantiate(module);
    if (typeof exports.answer !== 'function') throw new Error('missing answer export');
    expect(exports.answer()).toBe(7);
  });

  it('main-thread init options resolve to the same core binary memo', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return new Response(answerBytes, { headers: { 'Content-Type': 'application/wasm' } });
    });
    const options = await prepareSharedWasmInit(undefined, 'https://course.test/assets/worker.js');
    if (!options) throw new Error('core binary produced no init options');
    expect(await options.module_or_path).toBeInstanceOf(WebAssembly.Module);
    // Joined the first test's compile of CORE_BINARY: one binary, one fetch.
    expect(requests).toBe(0);
  });
});
