/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node wasm bootstrap.
 *
 * `@ifc-lite/wasm` is built with `wasm-pack --target web`, whose generated
 * `init()` resolves the `.wasm` via `fetch(new URL(..., import.meta.url))`.
 * Node's undici cannot `fetch()` a `file://` URL, so `GeometryProcessor.init()`
 * throws "fetch failed". We pre-initialise the wasm-bindgen singleton from disk
 * with `initSync`; the bridge's later `init()` then no-ops on the
 * `wasm !== undefined` guard. Idempotent and Node-only (never bundled for the
 * browser, which keeps the fetch path).
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { initSync } from '@ifc-lite/wasm';

let initialized = false;

/** Ensure the `@ifc-lite/wasm` module is initialised in a Node process. */
export async function ensureWasmForNode(): Promise<void> {
  if (initialized) return;
  const require = createRequire(import.meta.url);
  const jsPath = require.resolve('@ifc-lite/wasm');
  const wasmPath = join(dirname(jsPath), 'ifc-lite_bg.wasm');
  const bytes = await readFile(wasmPath);
  initSync({ module: bytes });
  initialized = true;
}
