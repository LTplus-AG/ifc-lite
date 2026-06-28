/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(here, 'pkg-threaded', 'ifc-lite.js');
const STUB = path.join(here, 'threaded-stub.js');

/**
 * Vite `resolve.alias` target for `@ifc-lite/wasm/threaded`: the built threaded
 * bundle (`pkg-threaded/ifc-lite.js`) when present, else a stub that throws if
 * actually invoked.
 *
 * Must be added as an alias entry ORDERED BEFORE `@ifc-lite/wasm` (more-specific
 * first, like the existing `@ifc-lite/parser/browser` entry): Vite's alias plugin
 * runs before user `enforce: 'pre'` plugins, and the `@ifc-lite/wasm` string alias
 * prefix-matches the subpath (-> `pkg/ifc-lite.js/threaded`, ENOTDIR), so this can
 * only be fixed at the alias layer, not by a resolver plugin.
 *
 * The threaded bundle is a gitignored build artifact (built only via
 * `BUILD_THREADED=1`), so it is ABSENT in a normal CI build; the stub keeps the
 * build green. The threaded geometry path is opt-in + off by default, so the stub
 * is never executed unless threading is explicitly enabled.
 */
export const threadedWasmAliasTarget = existsSync(REAL) ? REAL : STUB;
