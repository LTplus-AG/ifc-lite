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

/** Vite's raw-text import suffix (`./thing.ts?raw` → the file's source string). */
const RAW_SUFFIX = '?raw';

/** Absolute URL of the stub every `~icons/*` specifier collapses onto. */
const ICON_STUB = new URL('./icon-stub.tsx', import.meta.url).href;

/**
 * Absolute URL of the module the bare `cesium` specifier collapses onto. It
 * re-exports the real package and shadows only `Viewer` (which needs WebGL)
 * and the two providers a test has to be able to settle by hand — see that
 * file's header. The redirect is skipped for the stub's own
 * `import … from 'cesium'`, which is how it reaches the real package.
 */
const CESIUM_STUB = new URL('./cesium-stub.ts', import.meta.url).href;

/**
 * Vite resolves a `.css` import to a side-effecting module that injects the
 * stylesheet; Node cannot parse the file at all. `loadCesium()` imports
 * `cesium/Build/Cesium/Widgets/widgets.css` alongside the engine, so without
 * this the whole world-view module graph is unimportable under `tsx --test`
 * for a reason that has nothing to do with what any test is checking.
 * Stylesheets have no observable behaviour in a DOM-only test, so the faithful
 * Node analogue is an empty module.
 */
const CSS_STUB = new URL('./css-stub.mjs', import.meta.url).href;

/** Only rewrite files inside this repo — never node_modules, never Node internals. */
const REPO_ROOT = new URL('../../../../', import.meta.url).href;

/**
 * Prepended to repo modules that read `import.meta.env`. `??=` so a module that
 * has already been given a populated env (or a test that seeds
 * `globalThis.__VITE_ENV__` before importing) keeps it.
 */
const ENV_PRELUDE =
  'import.meta.env ??= (globalThis.__VITE_ENV__ ??= { MODE: "test", DEV: false, PROD: false });\n';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ICON_PREFIX)) {
    // Every icon renders the same stub. Tests that care about WHICH icon
    // should assert on an accessible name, not on the glyph.
    return { url: ICON_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier === 'cesium' && context.parentURL !== CESIUM_STUB) {
    return { url: CESIUM_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier.endsWith('.css') || specifier.endsWith('.css?inline')) {
    return { url: CSS_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier.endsWith(RAW_SUFFIX)) {
    // Keep the marker on the URL so `load` below can see it: tsx strips the
    // query and hands back the TRANSPILED module, which is how a `?raw` import
    // of a `.ts` file fails as "does not provide an export named 'default'"
    // rather than as an unresolved specifier.
    const base = await nextResolve(specifier.slice(0, -RAW_SUFFIX.length), context);
    return { ...base, url: base.url + RAW_SUFFIX, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(RAW_SUFFIX)) {
    // Vite's `?raw` is the file's TEXT, so read it rather than evaluating it.
    const text = readFileSync(fileURLToPath(url.slice(0, -RAW_SUFFIX.length)), 'utf8');
    return { source: `export default ${JSON.stringify(text)};\n`, format: 'module', shortCircuit: true };
  }

  const loaded = await nextLoad(url, context);

  if (!url.startsWith(REPO_ROOT) || url.includes('/node_modules/')) return loaded;
  if (loaded.format !== 'module' && loaded.format !== undefined) return loaded;

  // `source` is absent when the default loader defers reading to Node itself;
  // read it ourselves so the prelude can still be applied. Deliberately not
  // guarded: a repo module Node is about to evaluate but we cannot read is a
  // real failure, and swallowing it here would resurface as an inscrutable
  // `import.meta.env is undefined` much further away.
  let source = loaded.source;
  if (source == null) source = readFileSync(fileURLToPath(url), 'utf8');
  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');

  // Narrow on purpose: touching every module would make this harness
  // load-bearing for code that does not need it, and hide the next real break.
  if (!text.includes('import.meta.env')) return loaded;

  return { ...loaded, source: ENV_PRELUDE + text, format: 'module', shortCircuit: true };
}

export { ICON_PREFIX, ICON_STUB, pathToFileURL };
