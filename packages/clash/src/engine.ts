/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TsClashEngine, type ClashEngine } from './engine-ts/index.js';

export type { ClashEngine };

export type ClashBackend = 'ts' | 'wasm' | 'auto';

export interface CreateClashEngineOptions {
  /** `ts` reference engine (default for now). `wasm`/`auto` land in Phase 3. */
  backend?: ClashBackend;
}

/**
 * Create a clash engine. Phase 0 ships the TypeScript reference engine; the
 * Rust→WASM backend and `auto` selection arrive in Phase 3 behind this same
 * interface.
 */
export function createClashEngine(options: CreateClashEngineOptions = {}): ClashEngine {
  const backend = options.backend ?? 'auto';
  if (backend === 'wasm') {
    throw new Error(
      'Import { WasmClashEngine } from "@ifc-lite/clash/wasm" instead — the WASM backend ' +
        'needs async init and is kept off the core import graph (subpath-only).',
    );
  }
  // 'auto' resolves to the in-process TS engine. The Rust/WASM backend is opt-in
  // via @ifc-lite/clash/wasm (it requires an async module init before use).
  return new TsClashEngine();
}
