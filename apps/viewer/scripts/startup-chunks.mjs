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

/** Every built JS file outside `startup`, with its code, read one at a time. */
async function* lazyChunks(directory, startup) {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const file = join(entry.parentPath, entry.name);
    if (entry.isFile() && /\.m?js$/.test(entry.name) && !startup.has(file)) yield [file, await readFile(file, 'utf8')];
  }
}

/**
 * The body both gates share: no startup chunk may carry any group's
 * signatures, and some lazy chunk must carry each group, or the check would
 * pass vacuously. `missingHint` says what a vacuous build probably means.
 */
export async function checkLazyOnly(dist, groups, remedy, missingHint) {
  // Absolute, so lazy paths compare equal to the startup set's resolved ones.
  const directory = resolve(dist);
  const eager = await startupChunks(directory);
  for (const [file, code] of eager) {
    for (const { signatures } of groups) {
      for (const signature of signatures) {
        if (code.includes(signature)) throw new Error(`Startup chunk ${relative(directory, file)} contains ${signature}. ${remedy}`);
      }
    }
  }
  const lazy = [];
  const found = new Set();
  for await (const [file, code] of lazyChunks(directory, eager)) {
    const hits = groups.filter((group) => group.signatures.some((signature) => code.includes(signature)));
    for (const group of hits) found.add(group.name);
    if (hits.length) lazy.push(relative(directory, file));
  }
  const missing = groups.filter((group) => !found.has(group.name)).map((group) => group.name);
  if (missing.length) {
    throw new Error(`No chunk in ${directory} carries ${missing.join(', ')} code, so this check proves nothing. ${missingHint}`);
  }
  return { eager: [...eager.keys()].map((file) => relative(directory, file)).sort(), lazy: lazy.sort() };
}
