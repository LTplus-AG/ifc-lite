/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Memory introspection must never prevent worker completion or deterministic cleanup. */
export function readWorkerWasmHeap(api: { getMemory?: () => unknown } | null): number {
  try {
    const memory = api?.getMemory?.() as { buffer?: { byteLength?: unknown } } | null | undefined;
    const bytes = memory?.buffer?.byteLength;
    return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
  } catch (error) {
    console.warn('[Worker] wasm heap accounting unavailable; reporting 0 bytes:', error);
    return 0;
  }
}
