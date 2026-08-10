/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hook implementations registered by `vite-module-hooks.mjs`. This runs on
 * the module-loader thread, so it must not import anything from the app.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ICON_PREFIX = '~icons/';

/** Absolute URL of the stub every `~icons/*` specifier collapses onto. */
const ICON_STUB = new URL('./icon-stub.tsx', import.meta.url).href;

/** Only rewrite files inside this repo — never node_modules, never Node internals. */
const REPO_ROOT = new URL('../../../../', import.meta.url).href;

/**
 * Prepended to repo modules that read `import.meta.env`. `??=` so a module that
 * has already been given a populated env (or a test that seeds
 * `globalThis.__VITE_ENV__` before importing) keeps it.
 */
const ENV_PRELUDE =
  'import.meta.env ??= (globalThis.__VITE_ENV__ ??= { MODE: "test", DEV: false, PROD: false });\n';

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ICON_PREFIX)) {
    // Every icon renders the same stub. Tests that care about WHICH icon
    // should assert on an accessible name, not on the glyph.
    return { url: ICON_STUB, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);

  if (!url.startsWith(REPO_ROOT) || url.includes('/node_modules/')) return loaded;
  if (loaded.format !== 'module' && loaded.format !== undefined) return loaded;

  // `source` is absent when the default loader defers reading to Node itself;
  // read it ourselves so the prelude can still be applied.
  let source = loaded.source;
  if (source == null) {
    try {
      source = readFileSync(fileURLToPath(url), 'utf8');
    } catch {
      return loaded;
    }
  }
  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');

  // Narrow on purpose: touching every module would make this harness
  // load-bearing for code that does not need it, and hide the next real break.
  if (!text.includes('import.meta.env')) return loaded;

  return { ...loaded, source: ENV_PRELUDE + text, format: 'module', shortCircuit: true };
}

export { ICON_PREFIX, ICON_STUB, pathToFileURL };
