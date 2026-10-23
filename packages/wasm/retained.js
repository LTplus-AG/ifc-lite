/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Opt-in loader for the retained-geometry engine bundle (#7955). Importing
// this module fetches nothing: the separate `pkg-retained` engine (built with
// `BUILD_RETAINED=1 scripts/build-wasm.sh` and deployed by the application;
// the published package ships only its types) is imported and instantiated
// only when `loadRetainedEngine()` is called, and its RetainedBrowserExecutor loads
// the SMLib bundle from /smlib/ only when constructed. The default engine
// (`@ifc-lite/wasm`) never contains the executor.

const DEFAULT_MODULE = new URL('./pkg-retained/ifc-lite.js', import.meta.url);

/**
 * Import and initialize the retained engine module. `moduleUrl` points at a
 * deployed copy of `pkg-retained/ifc-lite.js`; `wasm` is forwarded to its
 * initializer (default: the sibling `ifc-lite_bg.wasm`). Memoized per URL.
 */
const loaded = new Map();
export function loadRetainedEngine({ moduleUrl = DEFAULT_MODULE, wasm } = {}) {
  const key = String(moduleUrl);
  if (!loaded.has(key)) {
    const pending = import(/* @vite-ignore */ key).then(async (engine) => {
      await engine.default(wasm === undefined ? undefined : { module_or_path: wasm });
      return engine;
    });
    // A failed load is not cached: the caller may deploy the bundle and retry.
    pending.catch(() => loaded.delete(key));
    loaded.set(key, pending);
  }
  return loaded.get(key);
}
