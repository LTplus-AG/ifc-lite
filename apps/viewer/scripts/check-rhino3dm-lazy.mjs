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

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { eagerScripts, resolveAsset } from '../../../scripts/perf-ratchet/measure-bundle.mjs';
import { staticImports } from '../../../scripts/check-viewer-retained-free.mjs';

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
const ALL_SIGNATURES = GROUPS.flatMap((group) => group.signatures);

const REMEDY = 'Keep rhino3dm and the Rhino scene wasm behind the Rhino export worker (src/workers/rhinoExport.worker.ts): '
  + 'find the static import that pulls @ifc-lite/rhino3dm, rhino3dm or @ifc-lite/wasm/rhino into the startup graph.';

export async function checkRhino3dmLazy(directory) {
  const index = join(directory, 'index.html');
  if (!(await stat(index).catch(() => null))?.isFile()) {
    throw new Error(`Viewer dist has no index.html in ${directory}. Build the viewer first or pass the dist directory.`);
  }
  const html = await readFile(index, 'utf8');
  for (const { name, wasm } of GROUPS) {
    if (wasm.test(html)) throw new Error(`index.html preloads ${name}. ${REMEDY}`);
  }
  const eager = new Set();
  const queue = eagerScripts(html).eager.map((url) => resolveAsset(directory, url));
  while (queue.length) {
    const file = queue.pop();
    if (eager.has(file)) continue;
    eager.add(file);
    const code = await readFile(file, 'utf8');
    for (const signature of ALL_SIGNATURES) {
      if (code.includes(signature)) throw new Error(`Startup chunk ${relative(directory, file)} contains ${signature}. ${REMEDY}`);
    }
    for (const specifier of staticImports(code)) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(specifier)) continue;
      const target = specifier.startsWith('/') ? resolveAsset(directory, specifier)
        : resolveAsset(directory, `/${relative(directory, resolve(dirname(file), specifier))}`);
      queue.push(target);
    }
  }
  const lazy = [];
  const found = new Set();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.m?js$/.test(entry.name) || eager.has(file)) continue;
      const code = await readFile(file, 'utf8');
      const groups = GROUPS.filter((group) => group.signatures.some((signature) => code.includes(signature)));
      for (const group of groups) found.add(group.name);
      if (groups.length) lazy.push(relative(directory, file));
    }
  }
  await walk(directory);
  for (const { name } of GROUPS) {
    if (!found.has(name)) {
      throw new Error(`No chunk in ${directory} carries ${name} code, so this check proves nothing. `
        + 'Was the Rhino export removed, or did the signatures change with an upgrade?');
    }
  }
  return { eager: [...eager].map((file) => relative(directory, file)).sort(), lazy: lazy.sort() };
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazy } = await checkRhino3dmLazy(directory);
  console.log(`rhino3dm lazy: ${eager.length} startup chunks free of rhino3dm and the Rhino scene wasm; lazy chunks carrying either: ${lazy.join(', ')}`);
}
