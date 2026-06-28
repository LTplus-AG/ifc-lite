/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fallback for `@ifc-lite/wasm/threaded` when the threaded bundle (`pkg-threaded`,
// built via `BUILD_THREADED=1 ./scripts/build-wasm.sh`) is absent — e.g. a fresh
// checkout or a CI build that does not produce it. The threaded geometry path is
// opt-in and OFF by default (`globalThis.__IFCLITE_THREADED_WASM__ === true`), so
// this module is never imported in a normal build. If threading IS enabled without
// the bundle present, these throw a clear, actionable error instead of a cryptic
// resolution failure. See packages/wasm/vite-threaded-resolver.mjs.

const NOT_BUILT = () => {
  throw new Error(
    '@ifc-lite/wasm/threaded is not built. Run `BUILD_THREADED=1 ./scripts/build-wasm.sh` ' +
      'to produce packages/wasm/pkg-threaded, or leave the threaded geometry path disabled ' +
      '(globalThis.__IFCLITE_THREADED_WASM__ defaults to off).',
  );
};

export default async function init() {
  NOT_BUILT();
}

export function initSync() {
  NOT_BUILT();
}

export async function initThreadPool() {
  NOT_BUILT();
}

export class IfcAPI {
  constructor() {
    NOT_BUILT();
  }
}
