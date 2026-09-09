/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-export of the shared WASM load-retry classification (issue #4247).
 *
 * The real implementation lives in `@ifc-lite/wasm-lifecycle` so
 * `@ifc-lite/geometry` and `@ifc-lite/parser` share exactly one copy of the
 * transient-vs-fatal WASM load-failure logic instead of maintaining two
 * independently-editable "twin" files.
 */
export {
  initWasmWithRetry,
  isTransientWasmLoadError,
  type InitWasmRetryOptions,
} from '@ifc-lite/wasm-lifecycle';
