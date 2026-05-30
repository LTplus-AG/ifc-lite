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
    throw new Error('The WASM clash backend lands in Phase 3; use backend "ts" or "auto".');
  }
  // 'auto' resolves to the TS engine until the WASM backend exists.
  return new TsClashEngine();
}
