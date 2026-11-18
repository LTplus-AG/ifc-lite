/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Internal (not a package export): the loader shared by the .3dm and
 * CityJSON exports for the separate export wasm. */

import { initWasmWithRetry } from './wasm-init-retry.js';
import { readNodeWasmBytes } from './node-wasm-bytes.js';

type ExportPayload = typeof import('@ifc-lite/wasm/rhino');
let engine: Promise<ExportPayload> | null = null;

/** Import and initialize the separate export wasm (`@ifc-lite/wasm/rhino`:
 * the Rhino scene builder and the CityJSON writer) once. It is never part of
 * the default engine, so nothing is fetched until the first .3dm or CityJSON
 * export. A failed load is not cached, so a later export retries. */
export function loadExportPayload(): Promise<ExportPayload> {
  engine ??= (async () => {
    const module = await import('@ifc-lite/wasm/rhino');
    const bytes = await readNodeWasmBytes('@ifc-lite/wasm/rhino_bg.wasm');
    await initWasmWithRetry(async () => { await module.default(bytes ? { module_or_path: bytes } : undefined); }, { label: 'rhino-export' });
    return module;
  })();
  engine.catch(() => { engine = null; });
  return engine;
}
