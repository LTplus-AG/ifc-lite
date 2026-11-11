/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The startup graph of a built viewer, for the build-tail gates that keep a
 * write path or runtime off it (`check-rhino3dm-lazy.mjs`,
 * `check-structural-writes-lazy.mjs`): index.html's module entry and
 * modulepreloads plus every chunk they import statically, the same walk
 * `check-viewer-retained-free.mjs --lazy` does.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { eagerScripts, resolveAsset } from '../../../scripts/perf-ratchet/measure-bundle.mjs';
import { staticImports } from '../../../scripts/check-viewer-retained-free.mjs';

/** index.html of a built viewer `dist/`, or a clear error when there is none. */
export async function readIndexHtml(directory) {
  const index = join(directory, 'index.html');
  if (!(await stat(index).catch(() => null))?.isFile()) {
    throw new Error(`Viewer dist has no index.html in ${directory}. Build the viewer first or pass the dist directory.`);
  }
  return readFile(index, 'utf8');
}

/** Absolute paths of every JS file the browser loads before first paint, with their code. */
export async function startupChunks(directory) {
  const eager = new Map();
  const queue = eagerScripts(await readIndexHtml(directory)).eager.map((url) => resolveAsset(directory, url));
  while (queue.length) {
    const file = queue.pop();
    if (eager.has(file)) continue;
    const code = await readFile(file, 'utf8');
    eager.set(file, code);
    for (const specifier of staticImports(code)) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(specifier)) continue;
      queue.push(specifier.startsWith('/') ? resolveAsset(directory, specifier)
        : resolveAsset(directory, `/${relative(directory, resolve(dirname(file), specifier))}`));
    }
  }
  return eager;
}

/** Absolute paths of every built JS file outside `startup`, with their code. */
export async function lazyChunks(directory, startup) {
  const lazy = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (/\.m?js$/.test(entry.name) && !startup.has(file)) lazy.set(file, await readFile(file, 'utf8'));
    }
  }
  await walk(directory);
  return lazy;
}
