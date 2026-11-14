/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@ifc-lite/wasm/core`: the geometry-core engine, generated into pkg-core/ by
// `BUILD_CORE=1 scripts/build-wasm.sh` (the release build always runs it).
// Alias `@ifc-lite/wasm` to this entry; its `ENGINE_BINARY_URL` is the core
// binary, which `@ifc-lite/geometry` compiles in the page and its workers.
export * from './pkg-core/ifc-lite.js';
export { default } from './pkg-core/ifc-lite.js';
