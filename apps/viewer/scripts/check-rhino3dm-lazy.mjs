#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the rhino3dm runtime (75 KB of JS plus a 2.67 MB wasm) and the Rhino
 * scene builder wasm (`@ifc-lite/wasm/rhino`) load only when someone exports a
 * .3dm, never at viewer startup (spec: docs/architecture/rhino-3dm-export.md,
 * "Performance and limits").
 *
 * The startup graph is index.html's module entry and modulepreloads plus every
 * chunk they import statically, the same walk `check-viewer-retained-free.mjs
 * --lazy` does. No file in it may carry rhino3dm code, and index.html may not
 * preload either wasm. Some other chunk must carry each, or the export is not in
 * this build and the check would pass vacuously.
 *
 * Runs at the tail of the viewer's `build` script, like check-tla-chunk-await.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { checkLazyOnly, readIndexHtml } from './startup-chunks.mjs';

/** Strings only rhino3dm code carries: the emscripten loader's wasm name and
 *  the adapter's embind calls. Not `@ifc-lite/rhino3dm`, which the startup
 *  bundle's package-version list names as plain data. */
export const RHINO3DM_SIGNATURES = ['rhino3dm.wasm', 'File3dmWriteOptions', 'toByteArrayOptions'];

/** Strings only the `@ifc-lite/wasm/rhino` glue carries: its wasm asset name
 *  and a wasm-bindgen export of its scene handle. */
const RHINO_SCENE_SIGNATURES = ['ifc-lite-rhino_bg', 'rhinoscenejs_free'];

const GROUPS = [
  { name: 'the rhino3dm wasm', signatures: RHINO3DM_SIGNATURES, wasm: /rhino3dm[^"'\s]*\.wasm/ },
  { name: 'the Rhino scene wasm', signatures: RHINO_SCENE_SIGNATURES, wasm: /ifc-lite-rhino_bg[^"'\s]*\.wasm/ },
];

const REMEDY = 'Keep rhino3dm and the Rhino scene wasm behind the Rhino export worker (src/workers/rhinoExport.worker.ts): '
  + 'find the static import that pulls @ifc-lite/rhino3dm, rhino3dm or @ifc-lite/wasm/rhino into the startup graph.';

export async function checkRhino3dmLazy(directory) {
  const html = await readIndexHtml(directory);
  for (const { name, wasm } of GROUPS) {
    if (wasm.test(html)) throw new Error(`index.html preloads ${name}. ${REMEDY}`);
  }
  return checkLazyOnly(directory, GROUPS, REMEDY, 'Was the Rhino export removed, or did the signatures change with an upgrade?');
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazy } = await checkRhino3dmLazy(directory);
  console.log(`rhino3dm lazy: ${eager.length} startup chunks free of rhino3dm and the Rhino scene wasm; lazy chunks carrying either: ${lazy.join(', ')}`);
}
