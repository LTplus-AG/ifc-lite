/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Initialise the `@ifc-lite/wasm` module once per realm, for the free
 * functions and handles the viewer calls outside the geometry workers (room
 * layout, clash intersection solids, scan outlines). One promise per realm:
 * every caller awaits the same compile, and a worker realm gets its own.
 */

import init from '@ifc-lite/wasm';

let ready: Promise<void> | null = null;
let loaded = false;

/** Initialise the wasm module once (idempotent; safe from every call site). */
export function ensureWasm(): Promise<void> {
  if (!ready) {
    ready = init().then(() => {
      loaded = true;
    });
  }
  return ready;
}

/** Whether `ensureWasm` has resolved, for a synchronous caller (a pointer move). */
export function wasmLoaded(): boolean {
  return loaded;
}
