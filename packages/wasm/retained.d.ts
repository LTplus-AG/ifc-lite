/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The retained engine: the default engine API plus the opt-in executor. */
export type RetainedEngine = typeof import('./pkg-retained/ifc-lite.js');

/**
 * Import and initialize the separate retained engine bundle. Nothing is
 * fetched until this is called; the executor's SMLib bundle at /smlib/ is
 * fetched only when a `RetainedBrowserExecutor` is constructed.
 */
export function loadRetainedEngine(options?: {
  moduleUrl?: string | URL;
  wasm?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
}): Promise<RetainedEngine>;
