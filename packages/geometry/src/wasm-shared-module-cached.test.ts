/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { cachedSharedWasmModule, compileSharedWasmModule } from './wasm-shared-module.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('#7036 parser memo lookup cannot acquire an unused engine, and joins only its exact existing binary', async () => {
  // The empty WASM module is valid engine-independent input for the acquisition
  // invariant. WebAssembly.compile executes genuinely; no module is fabricated.
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const fetch = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
  vi.stubGlobal('fetch', fetch);
  const url = `https://memo-control.invalid/${crypto.randomUUID()}.wasm`;
  expect(cachedSharedWasmModule(url)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  const pending = compileSharedWasmModule(url);
  const joined = cachedSharedWasmModule(url);
  expect(joined).toBeDefined();
  const module = await pending;
  expect(module).toBeInstanceOf(WebAssembly.Module);
  expect(await joined).toBe(module);
  expect(cachedSharedWasmModule(`${url}?different-binary`)).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});
