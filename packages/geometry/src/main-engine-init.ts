/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main thread's ONE wasm-bindgen engine init (#7036), shared by
 * `IfcLiteBridge.init()` and a host that starts it early (as soon as a load is
 * requested, so the instantiation overlaps the file read instead of following
 * it).
 *
 * One in-flight promise, not one call each: wasm-bindgen's `init` checks
 * "already initialized" only before its first await, so two overlapping calls
 * would both instantiate and the later one would replace the instance that
 * handles created in between point into. Only the in-flight call is shared, so
 * after a failure the next `init()` retries exactly as before.
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

/** Start the main-thread engine init without waiting for it; a failure is left to the load's own init to retry and report. */
export function prewarmMainThreadEngine(): void {
  initMainThreadEngine().catch((error: unknown) => {
    console.warn('[engine] early main-thread init failed; the load will retry:', error);
  });
}
