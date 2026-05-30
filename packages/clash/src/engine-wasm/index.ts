/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WASM-backed clash engine (`@ifc-lite/clash/wasm`).
 *
 * Behind a subpath so `@ifc-lite/wasm` never enters the core import graph. The
 * engine reuses the shared orchestrator with a `WasmKernel`, so its results are
 * identical to the TS engine's (the differential test pins this).
 */

import initWasm, { ClashSession, type InitInput } from '@ifc-lite/wasm';
import { runClash } from '../engine-ts/orchestrator.js';
import type { ClashEngine } from '../engine-ts/index.js';
import type { ClashElement, ClashResult, ClashRule, ClashSettings } from '../types.js';
import { WasmKernel } from './wasm-kernel.js';

let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module once (idempotent). In a browser, call with no
 * arguments — wasm-bindgen resolves the `.wasm` via `import.meta.url`. In Node
 * (or any non-bundler host), pass the `.wasm` bytes (a `BufferSource`) or a URL.
 */
export function initClashWasm(input?: InitInput): Promise<void> {
  if (!initPromise) {
    const loaded = input === undefined ? initWasm() : initWasm({ module_or_path: input });
    initPromise = loaded.then(() => undefined);
  }
  return initPromise;
}

export class WasmClashEngine implements ClashEngine {
  async run(
    elements: ClashElement[],
    rules: ClashRule[],
    settings: ClashSettings = {},
  ): Promise<ClashResult> {
    await initClashWasm();
    const session = new ClashSession();
    return runClash(elements, rules, settings, new WasmKernel(session));
  }
}

export { WasmKernel } from './wasm-kernel.js';
