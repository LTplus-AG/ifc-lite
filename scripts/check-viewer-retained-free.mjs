/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';

// Strings only retained CODE carries. Plain names such as `pkg-retained`,
// `/smlib` or `RetainedModelSession` also appear in changelog prose that the
// default What's New tab bundles, so they are not evidence of retained code.
// - wasm-bindgen glue/imports for the session class (`retainedmodelsession_free`);
// - the host Worker's engine URL and the SMLib driver's fixed Worker paths;
// - minified property access on the loaded engine module.
export const CODE_SIGNATURES = [
  'retainedmodelsession_',
  '/retained-engine/',
  '/smlib/worker.mjs',
  '/smlib/client.mjs',
  '.RetainedModelSession',
];

/** Inspect every emitted byte (including maps/wasm), not just entry chunks. */
export async function checkRetainedFree(directory) {
  if (!(await stat(join(directory, 'index.html'))).isFile()) throw new Error('Viewer dist has no index.html');
  let files = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (/retained|smlib/i.test(entry.name)) throw new Error(`Retained asset in default dist: ${file}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error(`Non-regular viewer asset: ${file}`);
      const bytes = await readFile(file);
      for (const forbidden of CODE_SIGNATURES) {
        if (bytes.includes(forbidden)) throw new Error(`Default dist contains ${forbidden}: ${file}`);
      }
      files++;
    }
  }
  await walk(directory);
  return files;
}
if (isMainEntry(import.meta.url)) {
  const files = await checkRetainedFree(resolve(process.argv[2] ?? 'apps/viewer/dist'));
  console.log(`Retained-free viewer dist: ${files} files checked`);
}
