/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  initWasmWithRetry,
  isTransientWasmLoadError,
  type InitWasmRetryOptions,
} from './wasm-init-retry.js';

export {
  WASM_PANIC_STASH_KEY,
  takeWasmPanicStash,
  restashWasmPanicLocation,
  type WasmPanicStash,
} from './wasm-panic-forward.js';
