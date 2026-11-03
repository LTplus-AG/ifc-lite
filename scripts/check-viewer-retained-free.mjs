/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { eagerScripts, resolveAsset } from './perf-ratchet/measure-bundle.mjs';

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

const LEAK_REMEDY = 'The default (VITE_RETAINED_GEOMETRY unset) build must resolve '
  + '@ifc-lite/viewer-retained to src/lib/retained/off.ts; find the import that pulls '
  + 'retained code or engine assets into the default graph and route it through that alias.';

/** Inspect every emitted byte (including maps/wasm), not just entry chunks. */
export async function checkRetainedFree(directory) {
  const index = await stat(join(directory, 'index.html')).catch(() => null);
  if (!index?.isFile()) {
    throw new Error(`Viewer dist has no index.html in ${directory}. Build the default viewer first `
      + '(pnpm build:e2e) or pass the dist directory as the first argument.');
  }
  let files = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (/retained|smlib/i.test(entry.name)) throw new Error(`Retained asset in default dist: ${file}. ${LEAK_REMEDY}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error(`Non-regular viewer asset: ${file}. Remove symlinks/special files from the dist; the gate only accepts regular files.`);
      const bytes = await readFile(file);
      for (const forbidden of CODE_SIGNATURES) {
        if (bytes.includes(forbidden)) throw new Error(`Default dist contains ${forbidden}: ${file}. ${LEAK_REMEDY}`);
      }
      files++;
    }
  }
  await walk(directory);
  return files;
}
/**
 * Static `import`/`export ... from` specifiers of a built ES chunk. Dynamic
 * `import("./x.js")` is excluded: `import` followed by `(` never reaches a quote.
 * A string that merely looks like an import can only add files, never hide one.
 */
export function staticImports(code) {
  const found = new Set();
  for (const m of code.matchAll(/\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"'\n]+\.m?js)["']/g)) found.add(m[1]);
  return [...found];
}

const LAZY_REMEDY = 'A VITE_RETAINED_GEOMETRY=lazy build must keep retained code behind the dynamic imports in '
  + 'src/lib/retained/lazy.tsx; find the static import that pulls it into the startup graph.';

/**
 * #7955 production opt-in (`VITE_RETAINED_GEOMETRY=lazy`): retained code may
 * exist, but only in chunks the browser does not load at startup. The startup
 * graph is index.html's module entry and modulepreloads plus everything they
 * import statically; none of it may carry a retained code signature. Some
 * other chunk must, or this is not a lazy retained build. Run before the engine
 * is installed into the dist.
 */
export async function checkRetainedLazy(directory) {
  const index = join(directory, 'index.html');
  if (!(await stat(index).catch(() => null))?.isFile()) {
    throw new Error(`Viewer dist has no index.html in ${directory}. Build the viewer with VITE_RETAINED_GEOMETRY=lazy `
      + 'first, or pass the dist directory as the first argument.');
  }
  const html = await readFile(index, 'utf8');
  for (const forbidden of CODE_SIGNATURES) if (html.includes(forbidden)) throw new Error(`index.html contains ${forbidden}. ${LAZY_REMEDY}`);
  const eager = new Set();
  const queue = eagerScripts(html).eager.map(url => resolveAsset(directory, url));
  while (queue.length) {
    const file = queue.pop();
    if (eager.has(file)) continue;
    eager.add(file);
    const code = await readFile(file, 'utf8');
    for (const forbidden of CODE_SIGNATURES) {
      if (code.includes(forbidden)) throw new Error(`Startup chunk ${relative(directory, file)} contains ${forbidden}. ${LAZY_REMEDY}`);
    }
    for (const specifier of staticImports(code)) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(specifier)) continue;
      const target = specifier.startsWith('/') ? resolveAsset(directory, specifier)
        : resolveAsset(directory, `/${relative(directory, resolve(dirname(file), specifier))}`);
      queue.push(target);
    }
  }
  const lazy = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.m?js$/.test(entry.name) || eager.has(file)) continue;
      const bytes = await readFile(file);
      if (CODE_SIGNATURES.some(signature => bytes.includes(signature))) lazy.push(relative(directory, file));
    }
  }
  await walk(directory);
  if (!lazy.length) {
    throw new Error(`No chunk in ${directory} carries retained code: not a VITE_RETAINED_GEOMETRY=lazy build. `
      + 'Rebuild with VITE_RETAINED_GEOMETRY=lazy and IFCLITE_RETAINED_ENGINE set, on a commit whose vite.config.ts maps '
      + 'the lazy mode to src/lib/retained/lazy.tsx (#8710), and keep that module\'s dynamic imports.');
  }
  return { eager: [...eager].map(file => relative(directory, file)).sort(), lazy: lazy.sort() };
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const directory = resolve(args.find(arg => !arg.startsWith('--')) ?? 'apps/viewer/dist');
  if (args.includes('--lazy')) {
    const { eager, lazy } = await checkRetainedLazy(directory);
    console.log(`Lazy retained viewer dist: ${eager.length} startup chunks retained-free; retained code only in ${lazy.length} lazy chunk(s)`);
  } else {
    const files = await checkRetainedFree(directory);
    console.log(`Retained-free viewer dist: ${files} files checked`);
  }
}
