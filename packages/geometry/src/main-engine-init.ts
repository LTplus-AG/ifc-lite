/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialize concurrent main-thread wasm-bindgen initialization (#7036).
 * wasm-bindgen checks its initialized state before its first await, so separate
 * concurrent calls could replace an instance after handles have been created.
 * Only the in-flight attempt is shared; a failed attempt remains retryable.
 */

import init from '@ifc-lite/wasm';
import { initWasmWithRetry } from './wasm-init-retry.js';
import { prepareSharedWasmInit } from './wasm-shared-module.js';

let pending: Promise<void> | null = null;

/** Initialize (or join the initialization of) the main-thread engine. */
export function initMainThreadEngine(): Promise<void> {
  if (pending) return pending;
  const attempt: Promise<void> = initWasmWithRetry(
    // A bundled fetch starts only when cold public init reads its options.
    // Acquisition remains inside the existing delayed transport retry.
    async () => { await init(await prepareSharedWasmInit()); },
    { label: 'ifc-lite-bridge' },
  ).finally(() => {
    // Only the in-flight call is shared: once it settles, a later init runs
    // wasm-bindgen's own (then immediate) "already initialized" path again.
    if (pending === attempt) pending = null;
  });
  pending = attempt;
  return attempt;
}
