/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/wasm/core`: the geometry-core engine (`pkg-core/`, built by
 * `BUILD_CORE=1 scripts/build-wasm.sh`). It is meant to replace
 * `@ifc-lite/wasm` through an exact bundler alias, so it is typed as the full
 * engine: the methods of the families it leaves out (exporters, LandXML,
 * clash, scan operations, PDF underlays) type-check but are absent at run
 * time. Its `ENGINE_BINARY_URL` is the core binary's URL.
 */
export * from './pkg/ifc-lite.js';
export { default } from './pkg/ifc-lite.js';
