/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient declarations for vendor modules with non-standard import
 * shapes (Vite `?url` asset queries) used by streaming sources.
 */

declare module 'laz-perf/lib/web/laz-perf.wasm?url' {
  const url: string;
  export default url;
}
