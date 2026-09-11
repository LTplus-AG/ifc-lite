/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-export of the shared worker-to-main-thread wasm panic-location forwarder
 * (issue #4247).
 *
 * The real implementation lives in `@ifc-lite/wasm-lifecycle` so
 * `@ifc-lite/geometry` and `@ifc-lite/parser` share exactly one copy of the
 * #2527 realm-forwarding contract instead of maintaining two
 * independently-editable "twin" files.
 */
export {
  WASM_PANIC_STASH_KEY,
  takeWasmPanicStash,
  restashWasmPanicLocation,
  type WasmPanicStash,
} from '@ifc-lite/wasm-lifecycle';
